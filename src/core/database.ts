// databases are pages whose subpages are rows, each row keeps its values in its frontmatter
import { COLORS, displayTitle } from './model';
import { dateKey } from './daily';
import type {
  ConditionalFormatRule,
  ColorName,
  DatabaseDef,
  DocNode,
  FilterOp,
  FilterRule,
  PageId,
  PageMeta,
  PropDef,
  PropType,
  PropValue,
  SelectOption,
  SortRule,
  SummaryOperation,
  ViewDef,
  ViewType,
  WorkspaceState,
} from './model';
import { propertyMediaLabel } from './propertyMedia';
import { computeRuntimeFormula, formulaUsesCurrentTime, parseFormula } from './formula';
import type { Expr, FormulaRowList, FormulaRowRef, FormulaRuntimeValue, FormulaSpan } from './formula';
import type { FormulaReferenceBinding } from './model';
import { childrenOf, isEffectivelyTrashed } from './tree';
import {
  isNumericPropertyType,
  isValidDateKey,
  isValidDateTime,
  isValidTime,
  durationUnitFactor,
  durationUnitFromText,
  parseLocalizedNumber,
  scalarValueError,
} from './typedValues';

// pseudo properties every row has
export const TITLE_PROP = 'title';
export const CREATED_PROP = 'created';
export const UPDATED_PROP = 'updated';

export const VIEW_LABELS: Record<ViewType, string> = {
  table: 'Table',
  board: 'Board',
  calendar: 'Calendar',
  list: 'List',
  gallery: 'Gallery',
};

export function filterOpsFor(type: PropType | 'title'): FilterOp[] {
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'slider':
    case 'progress':
    case 'scale':
    case 'duration':
    case 'date':
    case 'time':
    case 'datetime':
    case 'createdTime':
    case 'lastEditedTime':
      return ['is', 'isNot', 'gt', 'lt', 'empty', 'notEmpty'];
    case 'checkbox':
      return ['checked', 'unchecked'];
    case 'select':
    case 'multiSelect':
    case 'relation':
      return ['is', 'isNot', 'empty', 'notEmpty'];
    default:
      return ['contains', 'notContains', 'is', 'isNot', 'empty', 'notEmpty'];
  }
}

export function newOption(name: string, index: number, newId: () => string): SelectOption {
  return { id: newId(), name, color: COLORS[index % COLORS.length]! };
}

export function moveSelectOption(options: SelectOption[], index: number, direction: -1 | 1): SelectOption[] {
  const target = index + direction;
  if (index < 0 || index >= options.length || target < 0 || target >= options.length) return options;
  const moved = [...options];
  [moved[index], moved[target]] = [moved[target]!, moved[index]!];
  return moved;
}

export function newView(type: ViewType, database: DatabaseDef, newId: () => string): ViewDef {
  const select = database.properties.find((prop) => prop.type === 'select');
  const date = database.properties.find((prop) => prop.type === 'date' || prop.type === 'datetime');
  return {
    id: newId(),
    name: VIEW_LABELS[type],
    type,
    filters: [],
    sorts: [],
    groupBy: type === 'board' ? (select?.id ?? null) : null,
    dateProp: type === 'calendar' ? (date?.id ?? null) : null,
    hidden: [],
  };
}

export function defaultDatabase(newId: () => string): DatabaseDef {
  const status: PropDef = {
    id: newId(),
    name: 'Status',
    type: 'select',
    options: ['To do', 'Doing', 'Done'].map((name, index) => ({
      id: newId(),
      name,
      color: (['gray', 'blue', 'green'] as ColorName[])[index]!,
    })),
  };
  const date: PropDef = { id: newId(), name: 'Date', type: 'date', options: [] };
  const database: DatabaseDef = { properties: [status, date], views: [] };
  database.views = [
    newView('table', database, newId),
    newView('board', database, newId),
    newView('calendar', database, newId),
  ];
  return database;
}

export function rowsOf(state: WorkspaceState, databaseId: PageId): PageMeta[] {
  return childrenOf(state.pages, databaseId);
}

export function findDatabaseOf(state: WorkspaceState, page: PageMeta): PageMeta | null {
  const parent = page.parentId ? state.pages[page.parentId] : undefined;
  return parent?.kind === 'database' && parent.database ? parent : null;
}

export function databaseRowLabel(state: WorkspaceState, row: PageMeta, propertyId?: string | null): string {
  const database = findDatabaseOf(state, row)?.database;
  const selected = propertyId ?? database?.displayPropertyId;
  const property = database?.properties.find((candidate) => candidate.id === selected)
    ?? database?.properties.find((candidate) => candidate.id === database.displayPropertyId);
  if (!property || !database) return displayTitle(row);
  const label = formatValue(property, valueOf(row, property.id, database, state)).trim();
  return label || displayTitle(row);
}

export function valueOf(
  page: PageMeta,
  propId: string,
  database?: DatabaseDef,
  state?: WorkspaceState,
): PropValue {
  if (propId === TITLE_PROP) return displayTitle(page);
  if (propId === CREATED_PROP) return page.createdAt;
  if (propId === UPDATED_PROP) return page.updatedAt;
  const prop = database?.properties.find((candidate) => candidate.id === propId);
  if (prop?.type === 'button') return null;
  if (prop?.type === 'createdTime') return page.createdAt;
  if (prop?.type === 'lastEditedTime') return page.updatedAt;
  if (prop && (prop.type === 'formula' || prop.fillMode === 'calculated')) {
    const result = formulaResult(page, prop, database!, 0, state);
    if (result.error) return null;
    return calculatedPropertyValue(toPropertyValue(result.value, prop, state), prop);
  }
  if (prop?.type === 'relation' && prop.relation?.isInverse) {
    if (!state || !prop.relation.targetDatabaseId || !prop.relation.inversePropertyId) return null;
    const sourceDatabase = state.pages[prop.relation.targetDatabaseId];
    const sourceProp = sourceDatabase?.database?.properties.find(
      (candidate) => candidate.id === prop.relation?.inversePropertyId,
    );
    const sourceRelation = sourceProp?.relation;
    if (
      sourceDatabase?.kind !== 'database' ||
      sourceProp?.type !== 'relation' ||
      !sourceRelation ||
      sourceRelation.isInverse ||
      sourceRelation.targetDatabaseId !== page.parentId ||
      sourceRelation.inversePropertyId !== prop.id
    )
      return null;
    const related = childrenOf(state.pages, sourceDatabase.id)
      .filter((row) => {
        const value = row.properties[sourceProp.id];
        return Array.isArray(value) ? value.includes(page.id) : value === page.id;
      })
      .map((row) => row.id);
    return prop.relation.multiple ? related : (related[0] ?? null);
  }
  return page.properties[propId] ?? null;
}

export function calendarDayForRow(
  row: PageMeta,
  prop: PropDef,
  database: DatabaseDef,
  state?: WorkspaceState,
): string | null {
  const value = valueOf(row, prop.id, database, state);
  if (typeof value !== 'string') return null;
  const isDateTime = prop.type === 'datetime' || /^\d{4}-\d{2}-\d{2}T/.test(value);
  if (!isDateTime) return isValidDateKey(value) ? value : null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (!prop.format?.timeZone) return dateKey(date);
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: prop.format.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return dateKey(date);
  }
}

function calculatedPropertyValue(value: PropValue, prop: PropDef): PropValue {
  const optionId = (item: string) =>
    prop.options.find((option) => option.id === item)?.id ??
    prop.options.find((option) => option.name.toLocaleLowerCase() === item.toLocaleLowerCase())?.id ??
    item;
  if (prop.type === 'select' && typeof value === 'string') return optionId(value);
  if (prop.type === 'multiSelect' && typeof value === 'string') return [optionId(value)];
  if (prop.type === 'multiSelect' && Array.isArray(value)) return value.map(optionId);
  return value;
}

export function formulaOutputValue(
  value: FormulaRuntimeValue,
  prop: PropDef,
  state?: WorkspaceState,
): PropValue {
  return calculatedPropertyValue(toPropertyValue(value, prop, state), prop);
}

export interface FormulaResult {
  value: FormulaRuntimeValue;
  error: string | null;
}

interface FormulaEvaluationState {
  hasTimeDependentFormula: boolean;
  // nested document results share the same active formula stack, so cycles are reported safely
  // without caching a partial value.
}

const formulaCache = new WeakMap<WorkspaceState, Map<string, { result: FormulaResult; cachedAt: number }>>();

// A formula is evaluated against typed values and stable row/property IDs. Formula errors are
// returned to the caller so the cell can display them instead of turning them into blank/zero.
export function formulaResult(
  page: PageMeta,
  prop: PropDef,
  database: DatabaseDef,
  depth = 0,
  state?: WorkspaceState,
): FormulaResult {
  return evaluateFormulaForRow(page, prop, database, state, new Set(), depth, {
    hasTimeDependentFormula: false,
  });
}

export function documentFormulaResult(
  pageId: PageId,
  resultId: string,
  source: string,
  bindings: FormulaReferenceBinding[],
  state: WorkspaceState,
): FormulaResult {
  const page = state.pages[pageId];
  if (!page) return { value: null, error: 'The page for this calculated result is unavailable.' };
  const database = page.parentId ? state.pages[page.parentId]?.database : null;
  const prop: PropDef = {
    id: `document-result:${pageId}:${resultId}`,
    name: 'Calculated result',
    type: 'formula',
    options: [],
    formula: source,
    formulaBindings: bindings,
  };
  return evaluateFormulaForRow(page, prop, database ?? { properties: [], views: [] }, state, new Set(), 0, {
    hasTimeDependentFormula: false,
  });
}

function evaluateFormulaForRow(
  page: PageMeta,
  prop: PropDef,
  database: DatabaseDef,
  state: WorkspaceState | undefined,
  stack: Set<string>,
  depth: number,
  evaluation: FormulaEvaluationState,
): FormulaResult {
  if (depth > 64) return { value: null, error: 'Formula nesting is limited to 64 levels' };
  const source = prop.formula ?? '';
  if (formulaUsesCurrentTime(source)) evaluation.hasTimeDependentFormula = true;
  const key = `${page.id}:${prop.id}:${source}:${JSON.stringify([prop.formulaBindings ?? [], prop.type, prop.options, prop.format])}`;
  if (stack.has(key)) return { value: null, error: `Formula cycle detected at “${prop.name}”` };
  const canCache = Boolean(state && state.pages[page.id] === page) && !evaluation.hasTimeDependentFormula;
  const cached = canCache ? formulaCache.get(state!)?.get(key) : undefined;
  if (cached && Date.now() - cached.cachedAt < 1000) return cached.result;
  const active = new Set(stack);
  active.add(key);
  const bindings = prop.formulaBindings ?? [];
  const relationTargetForExpression = (expr: Expr): string | null => {
    if (expr.kind === 'identifier') {
      if (expr.name.toLocaleLowerCase() === 'thisrow') return page.parentId;
      const binding = matchingFormulaBinding(bindings, source, expr);
      if (binding?.kind !== 'property') return null;
      const schema = state?.pages[binding.databaseId]?.database ??
        (binding.databaseId === page.parentId ? database : undefined);
      if (!schema) return null;
      const property = resolveProperty(schema, expr.name, binding, binding.databaseId);
      return property.type === 'relation' ? (property.relation?.targetDatabaseId ?? null) : null;
    }
    if (expr.kind === 'member') {
      const span = { start: expr.nameStart, end: expr.nameEnd };
      const binding = matchingFormulaBinding(bindings, source, span);
      const databaseId = binding?.kind === 'property'
        ? binding.databaseId
        : relationTargetForExpression(expr.object);
      if (!databaseId) return null;
      const schema = state?.pages[databaseId]?.database ??
        (databaseId === page.parentId ? database : undefined);
      if (!schema) return null;
      const property = resolveProperty(schema, expr.name, binding, databaseId);
      return property.type === 'relation' ? (property.relation?.targetDatabaseId ?? null) : null;
    }
    if (
      expr.kind === 'call' &&
      expr.callee.kind === 'identifier' &&
      ['first', 'unique'].includes(expr.callee.name.toLocaleLowerCase()) &&
      expr.args[0]
    ) return relationTargetForExpression(expr.args[0]);
    return null;
  };
  const result = computeRuntimeFormula(source, {
    resolveIdentifier(name, span) {
      const folded = name.trim().toLocaleLowerCase();
      if (folded === 'thisrow') return { formulaKind: 'row', id: page.id, databaseId: page.parentId ?? '' };
      const binding = matchingFormulaBinding(bindings, source, span);
      if (binding?.kind === 'database') return tableReference(state, binding.databaseId);
      if (binding?.kind === 'ambiguous')
        throw new Error(`“${binding.source}” is ambiguous; choose a control or calculated result.`);
      if (binding?.kind === 'control') {
        if (!state) throw new Error(`Bound control “${binding.source}” is unavailable.`);
        const owner = state.pages[binding.pageId];
        const control = owner?.controls.find((item) => item.id === binding.controlId);
        if (!control) throw new Error(`Bound control “${binding.source}” is unavailable.`);
        if (control.type !== 'relation') return control.value;
        const targetId = control.relation?.targetDatabaseId;
        const target = targetId ? state.pages[targetId] : undefined;
        if (
          target?.kind !== 'database' ||
          !target.database ||
          isEffectivelyTrashed(state.pages, targetId!)
        ) throw new Error(`Relation control “${binding.source}” has no available target table.`);
        const ids = Array.isArray(control.value)
          ? control.value
          : typeof control.value === 'string'
            ? [control.value]
            : [];
        const rows = ids.map((id) => {
          const row = state.pages[id];
          if (!row || row.parentId !== targetId || isEffectivelyTrashed(state.pages, id))
            throw new Error(`Relation control “${binding.source}” contains an unavailable row.`);
          return { formulaKind: 'row' as const, id, databaseId: targetId! };
        });
        return control.relation?.multiple
          ? { formulaKind: 'rows', databaseId: targetId!, rows }
          : (rows[0] ?? null);
      }
      if (binding?.kind === 'result') {
        if (!state) throw new Error(`Bound calculated result “${binding.source}” is unavailable.`);
        const resultNode = findDocumentResult(state, binding.pageId, binding.resultId);
        if (!resultNode || typeof resultNode.attrs?.formula !== 'string')
          throw new Error(`Bound calculated result “${binding.source}” is unavailable.`);
        const resultPage = state.pages[binding.pageId];
        if (!resultPage) throw new Error(`Bound calculated result “${binding.source}” is unavailable.`);
        const nested: PropDef = {
          id: `document-result:${binding.pageId}:${binding.resultId}`,
          name: String(resultNode.attrs.name ?? binding.source),
          type: 'formula',
          options: [],
          formula: resultNode.attrs.formula,
          formulaBindings: Array.isArray(resultNode.attrs.bindings)
            ? (resultNode.attrs.bindings as FormulaReferenceBinding[])
            : [],
        };
        const nestedKey = `${binding.pageId}:${nested.id}:${nested.formula ?? ''}:${JSON.stringify([
          nested.formulaBindings ?? [],
          nested.type,
          nested.options,
          nested.format,
        ])}`;
        if (active.has(nestedKey)) throw new Error(`Formula cycle detected at “${binding.source}”`);
        const nestedDatabase = resultPage.parentId ? state.pages[resultPage.parentId]?.database : null;
        const calculated = evaluateFormulaForRow(
          resultPage,
          nested,
          nestedDatabase ?? { properties: [], views: [] },
          state,
          active,
          depth + 1,
          evaluation,
        );
        if (calculated.error) throw new Error(calculated.error);
        return calculated.value;
      }
      if (binding?.kind === 'property') {
        if (binding.databaseId !== page.parentId)
          throw new Error(`Bound property “${binding.source}” is not on this row`);
        return readPropertyById(
          page,
          binding.databaseId,
          binding.propertyId!,
          state,
          active,
          depth + 1,
          database,
          evaluation,
        );
      }
      const tables = state
        ? Object.values(state.pages).filter(
            (candidate) =>
              candidate.kind === 'database' &&
              candidate.database &&
              candidate.title.trim().toLocaleLowerCase() === folded,
          )
        : [];
      if (tables.length > 1)
        throw new Error(`Table name “${name}” is ambiguous; bind it to a specific table.`);
      if (tables.length === 1) return { formulaKind: 'table', databaseId: tables[0]!.id };
      const matches = database.properties.filter(
        (candidate) => candidate.name.trim().toLocaleLowerCase() === folded,
      );
      if (matches.length > 1)
        throw new Error(`Property name “${name}” is ambiguous; choose a specific column.`);
      if (matches.length === 1)
        return readPropertyById(
          page,
          page.parentId ?? '',
          matches[0]!.id,
          state,
          active,
          depth + 1,
          database,
          evaluation,
        );
      if (['title', 'name'].includes(folded)) return displayTitle(page);
      if (folded === 'created') return page.createdAt;
      if (['updated', 'edited'].includes(folded)) return page.updatedAt;
      throw new Error(`There is no property or table called “${name}”`);
    },
    resolveMember(receiver, name, span, receiverExpression) {
      if (receiver === null) {
        const targetDatabaseId = receiverExpression
          ? relationTargetForExpression(receiverExpression)
          : null;
        if (targetDatabaseId) {
          const target = state?.pages[targetDatabaseId];
          if (!target?.database)
            throw new Error(`Relation target “${targetDatabaseId}” is unavailable`);
          resolveProperty(
            target.database,
            name,
            matchingFormulaBinding(bindings, source, span),
            targetDatabaseId,
          );
          return null;
        }
        throw new Error(`Cannot read “${name}” from ${formulaType(receiver)}`);
      }
      if (typeof receiver !== 'object')
        throw new Error(`Cannot read “${name}” from ${formulaType(receiver)}`);
      const binding = matchingFormulaBinding(bindings, source, span);
      if (Array.isArray(receiver)) {
        if (!receiver.every(isFormulaRowRef)) {
          throw new Error(
            `Cannot project “${name}” from a list of ${receiver.length ? formulaType(receiver[0]!) : 'unknown values'}`,
          );
        }
        return receiver.map((row) =>
          readRowProperty(row, binding, name, state, active, depth + 1, evaluation),
        );
      }
      if ('formulaKind' in receiver && receiver.formulaKind === 'rows') {
        const target = state?.pages[receiver.databaseId];
        if (!target?.database) throw new Error(`Relation target “${receiver.databaseId}” is unavailable`);
        const field = resolveProperty(target.database, name, binding, target.id);
        return receiver.rows.map((row) =>
          readPropertyById(
            state!.pages[row.id]!,
            target.id,
            field.id,
            state,
            active,
            depth + 1,
            undefined,
            evaluation,
          ),
        );
      }
      if ('formulaKind' in receiver && receiver.formulaKind === 'table') {
        const target = state?.pages[receiver.databaseId];
        if (!target?.database)
          throw new Error(`Table “${target?.title ?? receiver.databaseId}” is unavailable`);
        const field = resolveProperty(target.database, name, binding, target.id);
        return rowsOf(state!, target.id).map((row) =>
          readPropertyById(row, target.id, field.id, state, active, depth + 1, undefined, evaluation),
        );
      }
      if ('formulaKind' in receiver && receiver.formulaKind === 'row')
        return readRowProperty(receiver, binding, name, state, active, depth + 1, evaluation);
      throw new Error(`Cannot read “${name}” from a list`);
    },
    invokeMethod(receiver, name, arguments_, evaluate, _span) {
      const method = name.toLocaleLowerCase();
      if (method === 'filter') {
        if (arguments_.length !== 1) throw new Error('Filter() expects one condition');
        const collection = tableRows(receiver, state);
        const filtered = collection.rows.filter((row) => {
          const accepted = evaluate(arguments_[0]!, row);
          if (typeof accepted !== 'boolean') throw new Error('Filter() condition must return true or false');
          return accepted;
        });
        return { formulaKind: 'rows', databaseId: collection.databaseId, rows: filtered };
      }
      const values = Array.isArray(receiver)
        ? receiver
        : typeof receiver === 'object' &&
            receiver !== null &&
            !Array.isArray(receiver) &&
            receiver.formulaKind === 'rows'
          ? receiver.rows
          : null;
      if (!values) throw new Error(`${name}() needs a list of values or rows`);
      if (
        method === 'sum' ||
        method === 'average' ||
        method === 'avg' ||
        method === 'min' ||
        method === 'max'
      ) {
        if (arguments_.length !== 0) throw new Error(`${name}() takes no arguments`);
        const numbers = values.map(formulaNumber);
        if (!numbers.length) return method === 'sum' ? 0 : null;
        return method === 'sum'
          ? numbers.reduce((a, b) => a + b, 0)
          : method === 'average' || method === 'avg'
            ? numbers.reduce((a, b) => a + b, 0) / numbers.length
            : method === 'min'
              ? Math.min(...numbers)
              : Math.max(...numbers);
      }
      if (method === 'count') {
        if (arguments_.length !== 0) throw new Error('Count() takes no arguments');
        return values.filter((value) => value !== null).length;
      }
      if (method === 'first') {
        if (arguments_.length !== 0) throw new Error('First() takes no arguments');
        return values[0] ?? null;
      }
      if (method === 'unique') {
        if (arguments_.length !== 0) throw new Error('Unique() takes no arguments');
        return values.filter(
          (value, index) => values.findIndex((candidate) => sameFormulaValue(candidate, value)) === index,
        );
      }
      if (method === 'contains') {
        if (arguments_.length !== 1) throw new Error('Contains() expects one value');
        const wanted = evaluate(arguments_[0]!);
        return values.some((value) => sameFormulaValue(value, wanted));
      }
      throw new Error(`There is no list function called ${name}()`);
    },
  });
  const normalized = result.error ? result : normalizeFormulaOutput(prop, result.value, state);
  const finalResult: FormulaResult = normalized.error
    ? { value: null, error: normalized.error }
    : { value: normalized.value, error: null };
  if (canCache && state && !evaluation.hasTimeDependentFormula) {
    let cache = formulaCache.get(state);
    if (!cache) {
      cache = new Map();
      formulaCache.set(state, cache);
    }
    if (cache.size > 20_000) cache.clear();
    cache.set(key, { result: finalResult, cachedAt: Date.now() });
  }
  return finalResult;
}

function normalizeFormulaOutput(
  prop: PropDef,
  value: FormulaRuntimeValue,
  state: WorkspaceState | undefined,
): { value: FormulaRuntimeValue; error: string | null } {
  if (prop.type === 'formula') {
    const error = validateFormulaOutput(value, state);
    return error ? { value: null, error: `${prop.name}: ${error}` } : { value, error: null };
  }
  if (prop.type === 'relation') return normalizeRelationFormulaOutput(prop, value, state);
  if (Array.isArray(value)) {
    if (prop.type === 'multiSelect') {
      const names = value.map((item) => (typeof item === 'string' ? item : null));
      if (names.some((item) => item === null))
        return { value: null, error: `${prop.name} formula must return a list of option names or IDs.` };
      const ids = names.map((name) => {
        const option = prop.options.find(
          (candidate) =>
            candidate.id === name || candidate.name.toLocaleLowerCase() === name!.toLocaleLowerCase(),
        );
        return option?.id;
      });
      if (ids.some((id) => !id))
        return { value: null, error: `${prop.name} formula returned an unknown option.` };
      const candidate = ids as string[];
      const error = scalarValueError(prop, candidate);
      return error ? { value: null, error } : { value: candidate, error: null };
    }
    return { value: null, error: `${prop.name} formula returned a list where one value is required.` };
  }
  if (value !== null && typeof value === 'object')
    return {
      value: null,
      error: `${prop.name} formula returned a list, row, or table where one value is required.`,
    };
  if (value === null) return { value, error: null };
  let candidate: PropValue = value;
  if (prop.type === 'select' && typeof value === 'string') {
    const option = prop.options.find(
      (item) => item.id === value || item.name.toLocaleLowerCase() === value.toLocaleLowerCase(),
    );
    if (!option) return { value: null, error: `${prop.name} formula returned an unknown option.` };
    candidate = option.id;
  }
  if (prop.type === 'multiSelect' && typeof value === 'string') {
    const names = value.split(',').map((item) => item.trim());
    const options = names.map((name) =>
      prop.options.find(
        (item) => item.id === name || item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      ),
    );
    if (options.some((item) => !item))
      return { value: null, error: `${prop.name} formula returned an unknown option.` };
    candidate = options.map((item) => item!.id);
  }
  const error = scalarValueError(prop, candidate);
  return error ? { value: null, error } : { value: candidate, error: null };
}

function validateFormulaOutput(
  value: FormulaRuntimeValue,
  state: WorkspaceState | undefined,
  depth = 0,
): string | null {
  if (depth > 64) return 'formula output is nested too deeply';
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'string') return value.length <= 10_000 ? null : 'text output is too long';
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'number output must be finite';
  if (Array.isArray(value)) {
    if (value.length > 2000) return 'list output is limited to 2,000 items';
    for (const item of value) {
      const error = validateFormulaOutput(item, state, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (value.formulaKind === 'row') {
    const row = state?.pages[value.id];
    if (!row || row.parentId !== value.databaseId || !state || isEffectivelyTrashed(state.pages, value.id))
      return `referenced row ${value.id} is unavailable`;
    return null;
  }
  if (value.formulaKind === 'rows') {
    if (value.rows.length > 2000) return 'row list output is limited to 2,000 items';
    const table = state?.pages[value.databaseId];
    if (!table?.database || !state || isEffectivelyTrashed(state.pages, value.databaseId))
      return `table ${value.databaseId} is unavailable`;
    for (const row of value.rows) {
      const error = validateFormulaOutput(row, state, depth + 1);
      if (error) return error;
    }
    return null;
  }
  const table = state?.pages[value.databaseId];
  return table?.database && state && !isEffectivelyTrashed(state.pages, value.databaseId)
    ? null
    : `table ${value.databaseId} is unavailable`;
}

function normalizeRelationFormulaOutput(
  prop: PropDef,
  value: FormulaRuntimeValue,
  state: WorkspaceState | undefined,
): { value: FormulaRuntimeValue; error: string | null } {
  const targetId = prop.relation?.targetDatabaseId;
  if (
    !targetId ||
    state?.pages[targetId]?.kind !== 'database' ||
    !state.pages[targetId]?.database ||
    isEffectivelyTrashed(state.pages, targetId)
  )
    return { value: null, error: `${prop.name} needs a configured relation table.` };
  let references: Array<FormulaRowRef | string>;
  if (isFormulaRowRef(value)) references = [value];
  else if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.formulaKind === 'rows'
  )
    references = value.rows;
  else if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.formulaKind === 'table'
  ) {
    if (value.databaseId !== targetId)
      return { value: null, error: `${prop.name} formula returned rows from the wrong table.` };
    references = rowsOf(state, targetId).map((row) => ({
      formulaKind: 'row',
      id: row.id,
      databaseId: targetId,
    }));
  } else if (Array.isArray(value)) {
    if (!value.every((item) => isFormulaRowRef(item) || typeof item === 'string'))
      return { value: null, error: `${prop.name} formula must return rows or row IDs.` };
    references = value as Array<FormulaRowRef | string>;
  } else if (typeof value === 'string') references = [value];
  else if (value === null) references = [];
  else return { value: null, error: `${prop.name} formula must return a row or list of rows.` };
  const ids: string[] = [];
  for (const reference of references) {
    if (isFormulaRowRef(reference) && reference.databaseId !== targetId)
      return { value: null, error: `${prop.name} formula returned a row from the wrong table.` };
    const id = typeof reference === 'string' ? reference : reference.id;
    const row = state.pages[id];
    if (!row || row.parentId !== targetId || isEffectivelyTrashed(state.pages, id))
      return { value: null, error: `${prop.name} formula returned an unavailable row.` };
    if (!ids.includes(id)) ids.push(id);
  }
  if (!prop.relation?.multiple && ids.length > 1)
    return { value: null, error: `${prop.name} allows one related row.` };
  return { value: prop.relation?.multiple ? ids : (ids[0] ?? null), error: null };
}

function toPropertyValue(
  value: FormulaRuntimeValue,
  prop: PropDef,
  state: WorkspaceState | undefined,
): PropValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) return value as string[];
    if (value.every(isFormulaRowRef)) return value.map((row) => row.id);
    return formulaValueText(prop, value, state);
  }
  if (isFormulaRowRef(value)) return value.id;
  if (value.formulaKind === 'rows') return value.rows.map((row) => row.id);
  return state ? rowsOf(state, value.databaseId).map((row) => row.id) : null;
}

export function formulaValueText(prop: PropDef, value: FormulaRuntimeValue, state?: WorkspaceState): string {
  if (Array.isArray(value)) return value.map((item) => formulaValueText(prop, item, state)).join(', ');
  if (value === null) return '';
  if (typeof value === 'object') {
    if (value.formulaKind === 'row')
      return state?.pages[value.id] ? databaseRowLabel(state, state.pages[value.id]!) : value.id;
    const rows =
      value.formulaKind === 'rows'
        ? value.rows.map((row) => state?.pages[row.id]).filter((row): row is PageMeta => Boolean(row))
        : state
          ? rowsOf(state, value.databaseId)
          : [];
    return rows.map((row) => state ? databaseRowLabel(state, row) : displayTitle(row)).join(', ');
  }
  if (prop.type === 'relation' && state && typeof value === 'string') {
    const row = state.pages[value];
    if (row) return databaseRowLabel(state, row);
  }
  return formatValue(prop, value);
}

function matchingFormulaBinding(
  bindings: FormulaReferenceBinding[],
  source: string,
  span: FormulaSpan,
): FormulaReferenceBinding | undefined {
  return bindings.find(
    (binding) =>
      binding.start === span.start &&
      binding.end === span.end &&
      source.slice(binding.start, binding.end) === binding.source,
  );
}

function findDocumentResult(state: WorkspaceState, pageId: PageId, resultId: string): DocNode | null {
  const document = state.docs[pageId];
  if (!document) return null;
  const stack = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'calculatedResult' && node.attrs?.resultId === resultId) return node;
    for (const child of node.content ?? []) stack.push(child);
  }
  return null;
}

function tableReference(state: WorkspaceState | undefined, databaseId: string): FormulaRuntimeValue {
  const table = state?.pages[databaseId];
  if (table?.kind !== 'database' || !table.database)
    throw new Error(`Bound table ${databaseId} no longer exists`);
  return { formulaKind: 'table', databaseId };
}

function resolveProperty(
  database: DatabaseDef,
  name: string,
  binding: FormulaReferenceBinding | undefined,
  databaseId: string,
): PropDef {
  if (binding?.kind === 'property') {
    if (binding.databaseId !== databaseId)
      throw new Error(`The bound column “${binding.source}” belongs to a different table`);
    const property = database.properties.find((candidate) => candidate.id === binding.propertyId);
    if (!property) throw new Error(`Bound column “${binding.source}” no longer exists`);
    return property;
  }
  const matches = database.properties.filter(
    (candidate) => candidate.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  if (matches.length > 1)
    throw new Error(`Column name “${name}” is ambiguous; bind it to a specific column.`);
  if (!matches[0]) throw new Error(`There is no column called “${name}” in this table`);
  return matches[0];
}

function readRowProperty(
  rowRef: FormulaRowRef,
  binding: FormulaReferenceBinding | undefined,
  name: string,
  state: WorkspaceState | undefined,
  stack: Set<string>,
  depth: number,
  evaluation: FormulaEvaluationState,
): FormulaRuntimeValue {
  const row = state?.pages[rowRef.id];
  const database = state?.pages[rowRef.databaseId];
  if (!row || database?.kind !== 'database' || !database.database)
    throw new Error(`Formula row ${rowRef.id} is unavailable`);
  const property = resolveProperty(database.database, name, binding, database.id);
  return readPropertyById(row, database.id, property.id, state, stack, depth, undefined, evaluation);
}

function readPropertyById(
  row: PageMeta,
  databaseId: string,
  propertyId: string,
  state: WorkspaceState | undefined,
  stack: Set<string>,
  depth: number,
  fallbackDatabase?: DatabaseDef,
  evaluation: FormulaEvaluationState = { hasTimeDependentFormula: false },
): FormulaRuntimeValue {
  const owner = state?.pages[databaseId];
  const database =
    owner?.database ?? (row.parentId === null || row.parentId === databaseId ? fallbackDatabase : undefined);
  const property = database?.properties.find((candidate) => candidate.id === propertyId);
  if (!property || !database) throw new Error(`Bound column “${propertyId}” no longer exists`);
  if (property.type === 'formula' || property.fillMode === 'calculated') {
    const nested = evaluateFormulaForRow(row, property, database, state, stack, depth + 1, evaluation);
    if (nested.error) throw new Error(`Column “${property.name}”: ${nested.error}`);
    if (property.type === 'relation') {
      const targetId = property.relation?.targetDatabaseId;
      if (!targetId) return null;
      const ids =
        typeof nested.value === 'string'
          ? [nested.value]
          : Array.isArray(nested.value) && nested.value.every((item) => typeof item === 'string')
            ? nested.value
            : [];
      const refs = ids
        .map((id) => state?.pages[id])
        .filter(
          (candidate): candidate is PageMeta =>
            candidate?.parentId === targetId && candidate.trashedAt === null,
        )
        .map((candidate) => ({ formulaKind: 'row' as const, id: candidate.id, databaseId: targetId }));
      return property.relation?.multiple
        ? { formulaKind: 'rows', databaseId: targetId, rows: refs }
        : (refs[0] ?? null);
    }
    if (property.type === 'select' && typeof nested.value === 'string')
      return property.options.find((option) => option.id === nested.value)?.name ?? nested.value;
    if (property.type === 'multiSelect' && Array.isArray(nested.value))
      return nested.value.map((id) => property.options.find((option) => option.id === id)?.name ?? id);
    return nested.value;
  }
  if (property.type === 'relation' && property.relation?.targetDatabaseId) {
    const targetId = property.relation.targetDatabaseId;
    const target = state?.pages[targetId];
    if (target?.kind !== 'database' || !target.database)
      throw new Error(`Relation target “${targetId}” no longer exists`);
    const value = valueOf(row, propertyId, database, state);
    const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    const related: PageMeta[] = [];
    for (const id of ids) {
      const candidate = state?.pages[id];
      if (!candidate || candidate.parentId !== targetId || candidate.trashedAt !== null)
        throw new Error(`Relation “${property.name}” points to an unavailable row: ${id}`);
      related.push(candidate);
    }
    const refs = related.map((candidate) => ({
      formulaKind: 'row' as const,
      id: candidate.id,
      databaseId: targetId,
    }));
    return property.relation.multiple
      ? { formulaKind: 'rows', databaseId: targetId, rows: refs }
      : (refs[0] ?? null);
  }
  const value = valueOf(row, propertyId, database, state);
  if (property.type === 'select' && typeof value === 'string')
    return property.options.find((option) => option.id === value)?.name ?? value;
  if (property.type === 'multiSelect' && Array.isArray(value))
    return value.map((id) => property.options.find((option) => option.id === id)?.name ?? id);
  return value;
}

function tableRows(receiver: FormulaRuntimeValue, state: WorkspaceState | undefined): FormulaRowList {
  if (
    typeof receiver === 'object' &&
    receiver !== null &&
    !Array.isArray(receiver) &&
    receiver.formulaKind === 'rows'
  )
    return receiver;
  if (Array.isArray(receiver)) {
    if (!receiver.every(isFormulaRowRef)) throw new Error('Filter() expects rows');
    return { formulaKind: 'rows', databaseId: receiver[0]?.databaseId ?? '', rows: receiver };
  }
  if (typeof receiver !== 'object' || receiver === null || receiver.formulaKind !== 'table')
    throw new Error('Filter() must be called on a table or list of rows');
  if (!state?.pages[receiver.databaseId]?.database) throw new Error('The table is unavailable');
  return {
    formulaKind: 'rows',
    databaseId: receiver.databaseId,
    rows: rowsOf(state, receiver.databaseId).map((row) => ({
      formulaKind: 'row',
      id: row.id,
      databaseId: receiver.databaseId,
    })),
  };
}

function isFormulaRowRef(value: FormulaRuntimeValue): value is FormulaRowRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.formulaKind === 'row';
}

function formulaType(value: FormulaRuntimeValue): string {
  return value === null
    ? 'blank'
    : Array.isArray(value)
      ? 'a list'
      : typeof value === 'object'
        ? value.formulaKind === 'row'
          ? 'a row'
          : value.formulaKind === 'rows'
            ? 'a list of rows'
            : 'a table'
        : typeof value;
}

function formulaNumber(value: FormulaRuntimeValue): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`Aggregate expected a number, received ${formulaType(value)}`);
}

function sameFormulaValue(a: FormulaRuntimeValue, b: FormulaRuntimeValue): boolean {
  if (a === b) return true;
  return isFormulaRowRef(a) && isFormulaRowRef(b) && a.id === b.id && a.databaseId === b.databaseId;
}

// Resolve references once when a formula is saved. The original readable source stays unchanged;
// validated spans point to IDs so a later rename does not alter what the expression means.
export function bindFormulaReferences(
  source: string,
  ownerDatabaseId: string,
  state: WorkspaceState,
  existing: FormulaReferenceBinding[] = [],
): FormulaReferenceBinding[] {
  let root: Expr;
  try {
    root = parseFormula(source);
  } catch {
    return validBindings(source, existing, state);
  }
  const result = new Map<string, FormulaReferenceBinding>();
  const old = validBindings(source, existing, state);
  for (const binding of old) result.set(`${binding.start}:${binding.end}`, binding);
  const add = (
    span: FormulaSpan,
    kind: 'database' | 'property',
    databaseId: string,
    propertyId?: string,
  ) => {
    const text = source.slice(span.start, span.end);
    if (!text || text.length > 256) return;
    const key = `${span.start}:${span.end}`;
    const prior = result.get(key);
    // Existing IDs are deliberate bindings. Keep deleted and cross-kind references diagnosable
    // instead of retargeting them to a same-named database/property/control.
    if (prior) return;
    result.set(
      key,
      kind === 'property'
        ? { start: span.start, end: span.end, source: text, kind, databaseId, propertyId: propertyId! }
        : { start: span.start, end: span.end, source: text, kind, databaseId },
    );
  };
  const current = (databaseId: string | null) =>
    databaseId && state.pages[databaseId]?.database ? databaseId : null;
  const dbByName = (name: string, span: FormulaSpan): string | null => {
    const bound = old.find(
      (item) => item.start === span.start && item.end === span.end && item.kind === 'database',
    );
    if (bound?.kind === 'database') return current(bound.databaseId);
    const matches = Object.values(state.pages).filter(
      (page) =>
        page.kind === 'database' &&
        page.database &&
        page.title.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    return matches.length === 1 ? matches[0]!.id : null;
  };
  const propertyByName = (databaseId: string, name: string, span: FormulaSpan): PropDef | null => {
    const bound = old.find(
      (item) =>
        item.start === span.start &&
        item.end === span.end &&
        item.kind === 'property' &&
        item.databaseId === databaseId,
    );
    const database = state.pages[databaseId]?.database;
    if (!database) return null;
    if (bound?.kind === 'property') return database.properties.find((item) => item.id === bound.propertyId) ?? null;
    const matches = database.properties.filter(
      (item) => item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    return matches.length === 1 ? matches[0]! : null;
  };
  const dataSource = (
    expr: Expr,
    currentDatabaseId: string | null,
    aliases: Map<string, string | null>,
  ): string | null => {
    if (expr.kind === 'identifier') {
      const name = expr.name.toLocaleLowerCase();
      if (name === 'thisrow') return current(ownerDatabaseId);
      if (name === 'currentvalue') return current(currentDatabaseId);
      if (aliases.has(name)) return current(aliases.get(name) ?? null);
      return dbByName(expr.name, expr);
    }
    if (expr.kind === 'member') {
      const databaseId = dataSource(expr.object, currentDatabaseId, aliases);
      if (!databaseId) return null;
      const property = propertyByName(databaseId, expr.name, { start: expr.nameStart, end: expr.nameEnd });
      return current(property?.type === 'relation' ? (property.relation?.targetDatabaseId ?? null) : null);
    }
    if (expr.kind === 'call' && expr.callee.kind === 'member') {
      const method = expr.callee.name.toLocaleLowerCase();
      if (
        method === 'filter' ||
        method === 'formulamap' ||
        method === 'foreach' ||
        method === 'first' ||
        method === 'unique'
      )
        return dataSource(expr.callee.object, currentDatabaseId, aliases);
    }
    if (
      expr.kind === 'call' &&
      expr.callee.kind === 'identifier' &&
      ['formulamap', 'foreach', 'first', 'unique'].includes(expr.callee.name.toLocaleLowerCase())
    )
      return expr.args[0] ? dataSource(expr.args[0], currentDatabaseId, aliases) : null;
    return null;
  };
  const visit = (
    expr: Expr,
    currentDatabaseId: string | null,
    aliases = new Map<string, string | null>(),
  ) => {
    if (expr.kind === 'identifier') {
      const name = expr.name.toLocaleLowerCase();
      if (['thisrow', 'currentvalue', 'true', 'false', 'null', 'blank'].includes(name) || aliases.has(name))
        return;
      const databaseId = dbByName(expr.name, expr);
      if (databaseId) add(expr, 'database', databaseId);
      else if (currentDatabaseId) {
        const property = propertyByName(currentDatabaseId, expr.name, expr);
        if (property) add(expr, 'property', currentDatabaseId, property.id);
      }
      return;
    }
    if (expr.kind === 'literal') return;
    if (expr.kind === 'list') {
      for (const item of expr.items) visit(item, currentDatabaseId, aliases);
      return;
    }
    if (expr.kind === 'unary') {
      visit(expr.arg, currentDatabaseId, aliases);
      return;
    }
    if (expr.kind === 'binary') {
      visit(expr.left, currentDatabaseId, aliases);
      visit(expr.right, currentDatabaseId, aliases);
      return;
    }
    if (expr.kind === 'member') {
      visit(expr.object, currentDatabaseId, aliases);
      const databaseId = dataSource(expr.object, currentDatabaseId, aliases);
      if (databaseId) {
        const property = propertyByName(databaseId, expr.name, { start: expr.nameStart, end: expr.nameEnd });
        if (property) add({ start: expr.nameStart, end: expr.nameEnd }, 'property', databaseId, property.id);
      }
      return;
    }
    if (expr.callee.kind === 'identifier' && expr.callee.name.toLocaleLowerCase() === 'prop') {
      const arg = expr.args[0];
      if (arg?.kind === 'literal' && typeof arg.value === 'string' && currentDatabaseId) {
        const property = propertyByName(currentDatabaseId, arg.value, arg);
        if (property) add(arg, 'property', currentDatabaseId, property.id);
      }
      return;
    }
    if (expr.callee.kind === 'identifier' && expr.callee.name.toLocaleLowerCase() === '__index') {
      const receiver = expr.args[0];
      const key = expr.args[1];
      if (receiver) visit(receiver, currentDatabaseId, aliases);
      const databaseId = receiver ? dataSource(receiver, currentDatabaseId, aliases) : null;
      if (databaseId && key?.kind === 'literal' && typeof key.value === 'string') {
        const property = propertyByName(databaseId, key.value, key);
        if (property) add(key, 'property', databaseId, property.id);
      }
      return;
    }
    if (expr.callee.kind === 'member') {
      visit(expr.callee.object, currentDatabaseId, aliases);
      const method = expr.callee.name.toLocaleLowerCase();
      const receiverDatabaseId = dataSource(expr.callee.object, currentDatabaseId, aliases);
      const argumentDatabaseId = method === 'filter' ? receiverDatabaseId : currentDatabaseId;
      for (const arg of expr.args) visit(arg, argumentDatabaseId, aliases);
      return;
    }
    if (
      expr.callee.kind === 'identifier' &&
      ['formulamap', 'foreach'].includes(expr.callee.name.toLocaleLowerCase())
    ) {
      const itemDatabaseId = expr.args[0] ? dataSource(expr.args[0], currentDatabaseId, aliases) : null;
      if (expr.args[0]) visit(expr.args[0], currentDatabaseId, aliases);
      if (expr.args[1]) visit(expr.args[1], itemDatabaseId, aliases);
      return;
    }
    if (
      expr.callee.kind === 'identifier' &&
      expr.callee.name.toLocaleLowerCase() === 'withname' &&
      expr.args.length === 3
    ) {
      visit(expr.args[0]!, currentDatabaseId, aliases);
      visit(expr.args[1]!, currentDatabaseId, aliases);
      const nextAliases = new Map(aliases);
      const alias = expr.args[1];
      const aliasName =
        alias?.kind === 'literal' && typeof alias.value === 'string'
          ? alias.value
          : alias?.kind === 'identifier'
            ? alias.name
            : null;
      if (aliasName)
        nextAliases.set(aliasName.toLocaleLowerCase(), dataSource(expr.args[0]!, currentDatabaseId, aliases));
      visit(expr.args[2]!, currentDatabaseId, nextAliases);
      return;
    }
    visit(expr.callee, currentDatabaseId, aliases);
    for (const arg of expr.args) visit(arg, currentDatabaseId, aliases);
  };
  visit(root, ownerDatabaseId);
  return [...result.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

// Document results and linked-view formula filters share the page's named controls. Bind their
// readable names to stable page/control or page/result IDs while keeping database/property binding.
export function bindPageFormulaReferences(
  source: string,
  scopePageId: PageId,
  state: WorkspaceState,
  ownerDatabaseId?: PageId | null,
  existing: FormulaReferenceBinding[] = [],
): FormulaReferenceBinding[] {
  const owner = state.pages[scopePageId];
  const databaseId = ownerDatabaseId ?? owner?.parentId ?? scopePageId;
  const base = bindFormulaReferences(source, databaseId, state, existing);
  let root: Expr;
  try {
    root = parseFormula(source);
  } catch {
    return base;
  }
  const scope = state.pages[scopePageId];
  if (!scope) return base;
  const priorSpans = new Set(
    validBindings(source, existing, state).map((binding) => `${binding.start}:${binding.end}`),
  );
  const named: Array<{ name: string; kind: 'control' | 'result'; id: string }> = [
    ...scope.controls.map((control) => ({ name: control.name, kind: 'control' as const, id: control.id })),
    ...documentResults(state.docs[scopePageId]).map((result) => ({
      name: String(result.attrs?.name ?? ''),
      kind: 'result' as const,
      id: String(result.attrs?.resultId ?? ''),
    })),
  ].filter((item) => item.name && item.id);
  const bindings = new Map(base.map((binding) => [`${binding.start}:${binding.end}`, binding]));
  const visit = (expr: Expr, aliases: Set<string>, isCallee = false): void => {
    if (expr.kind === 'identifier') {
      const folded = expr.name.toLocaleLowerCase();
      if (isCallee || aliases.has(folded) || ['true', 'false', 'null', 'blank', 'thisrow', 'currentvalue'].includes(folded))
        return;
      const key = `${expr.start}:${expr.end}`;
      // Once a user or a prior save chose an identity, a later rename or duplicate name cannot retarget it.
      if (priorSpans.has(key)) return;
      const matches = named.filter((item) => item.name.trim().toLocaleLowerCase() === folded);
      const priorBinding = bindings.get(key);
      const collidesWithDataReference = priorBinding?.kind === 'database' || priorBinding?.kind === 'property';
      if (matches.length > 1 || (matches.length > 0 && collidesWithDataReference)) {
        bindings.set(key, {
          start: expr.start,
          end: expr.end,
          source: source.slice(expr.start, expr.end),
          kind: 'ambiguous',
          pageId: scopePageId,
        });
      } else if (matches.length === 1) {
        const match = matches[0]!;
        const span = { start: expr.start, end: expr.end, source: source.slice(expr.start, expr.end), pageId: scopePageId };
        bindings.set(key, match.kind === 'control'
          ? { ...span, kind: 'control', controlId: match.id }
          : { ...span, kind: 'result', resultId: match.id });
      }
      return;
    }
    if (expr.kind === 'literal') return;
    if (expr.kind === 'list') {
      expr.items.forEach((item) => visit(item, aliases));
      return;
    }
    if (expr.kind === 'unary') {
      visit(expr.arg, aliases);
      return;
    }
    if (expr.kind === 'binary') {
      visit(expr.left, aliases);
      visit(expr.right, aliases);
      return;
    }
    if (expr.kind === 'member') {
      visit(expr.object, aliases);
      return;
    }
    if (expr.callee.kind === 'identifier' && expr.callee.name.toLocaleLowerCase() === 'withname' && expr.args.length === 3) {
      if (expr.args[0]) visit(expr.args[0], aliases);
      if (expr.args[1]) visit(expr.args[1], aliases);
      const alias = expr.args[1];
      const aliasName = alias?.kind === 'literal' && typeof alias.value === 'string'
        ? alias.value
        : alias?.kind === 'identifier' ? alias.name : '';
      const nested = new Set(aliases);
      if (aliasName) nested.add(aliasName.toLocaleLowerCase());
      if (expr.args[2]) visit(expr.args[2], nested);
      return;
    }
    if (expr.callee.kind === 'member') visit(expr.callee.object, aliases);
    else visit(expr.callee, aliases, true);
    expr.args.forEach((arg) => visit(arg, aliases));
  };
  visit(root, new Set());
  return [...bindings.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

function documentResults(doc: DocNode | undefined): DocNode[] {
  if (!doc) return [];
  const found: DocNode[] = [];
  const stack = [doc];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'calculatedResult') found.push(node);
    for (const child of node.content ?? []) stack.push(child);
  }
  return found;
}

function validBindings(
  source: string,
  bindings: FormulaReferenceBinding[],
  state: WorkspaceState,
): FormulaReferenceBinding[] {
  void state;
  return bindings.filter((binding) => source.slice(binding.start, binding.end) === binding.source);
}

export function propType(database: DatabaseDef, propId: string): PropType | 'title' | null {
  if (propId === TITLE_PROP) return 'title';
  if (propId === CREATED_PROP) return 'createdTime';
  if (propId === UPDATED_PROP) return 'lastEditedTime';
  return database.properties.find((prop) => prop.id === propId)?.type ?? null;
}

// plain text for searching, sorting and exporting
export function formatValue(prop: PropDef | undefined, value: PropValue): string {
  if (value === null || value === undefined) return '';
  if (!prop) return Array.isArray(value) ? value.join(', ') : String(value);
  switch (prop.type) {
    case 'select':
      return prop.options.find((option) => option.id === value)?.name ?? '';
    case 'multiSelect':
      return (Array.isArray(value) ? value : [])
        .map((id) => prop.options.find((option) => option.id === id)?.name)
        .filter(Boolean)
        .join(', ');
    case 'checkbox':
      return value === true ? 'Yes' : 'No';
    case 'relation':
      return (Array.isArray(value) ? value : [value]).join(', ');
    case 'image':
    case 'file':
    case 'richCanvas':
      return propertyMediaLabel(prop, value);
    case 'formula':
      return typeof value === 'number'
        ? String(Math.round(value * 1e6) / 1e6)
        : typeof value === 'boolean'
          ? value
            ? 'Yes'
            : 'No'
          : String(value);
    case 'button':
      return '';
    case 'currency':
      return formatNumber(prop, value, 'currency');
    case 'percent':
      return formatNumber(prop, value, 'percent');
    case 'number':
    case 'slider':
    case 'progress':
    case 'scale':
      return formatNumber(prop, value, 'decimal');
    case 'duration':
      return formatDuration(prop, value);
    case 'date':
      return formatDateOnly(prop, value);
    case 'time':
      return formatTime(prop, value);
    case 'datetime':
      return formatDateTime(prop, value);
    case 'createdTime':
    case 'lastEditedTime':
      return formatTimestamp(prop, value);
    default:
      return String(value);
  }
}

// Localizes text shown to a person while keeping canonical/search values stable for core operations.
export function formatDisplayValue(prop: PropDef | undefined, value: PropValue, locale = 'en'): string {
  const text = formatValue(prop, value);
  if (locale !== 'pt' && !locale.startsWith('pt-') && locale !== 'es') return text;
  if (prop?.type !== 'checkbox' && prop?.type !== 'formula') return text;
  const yes = locale === 'es' ? 'Sí' : 'Sim';
  const no = locale === 'es' ? 'No' : 'Não';
  if (text === 'Yes') return yes;
  if (text === 'No') return no;
  if (prop.type === 'formula') {
    const parts = text.split(', ');
    if (parts.length > 1 && parts.every((part) => part === 'Yes' || part === 'No'))
      return parts.map((part) => part === 'Yes' ? yes : no).join(', ');
  }
  return text;
}

function formatNumber(prop: PropDef, value: PropValue, style: 'decimal' | 'currency' | 'percent'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const format = prop.format;
  const locale = format?.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  const precision = format?.precision ?? (style === 'currency' ? 2 : 2);
  try {
    const formatter = new Intl.NumberFormat(locale, {
      style,
      ...(style === 'currency' ? { currency: format?.currency ?? 'BRL' } : {}),
      maximumFractionDigits: precision,
      ...(format?.precision !== undefined || style === 'currency'
        ? { minimumFractionDigits: precision }
        : {}),
    });
    if (format?.negativeFormat === 'parentheses' && value < 0)
      return `(${formatter.format(Math.abs(value))})`;
    return formatter.format(value);
  } catch {
    return String(value);
  }
}

function dateFormatter(prop: PropDef, extra: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = prop.format?.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  return new Intl.DateTimeFormat(locale, extra);
}

function formatDateOnly(prop: PropDef, value: PropValue): string {
  if (typeof value !== 'string' || !isValidDateKey(value)) return String(value);
  const [year, month, day] = value.split('-').map(Number);
  try {
    const date = new Date(0);
    date.setUTCFullYear(year!, month! - 1, day!);
    date.setUTCHours(0, 0, 0, 0);
    return dateFormatter(prop, {
      dateStyle: prop.format?.dateStyle ?? 'medium',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return value;
  }
}

function formatTime(prop: PropDef, value: PropValue): string {
  if (typeof value !== 'string' || !isValidTime(value)) return String(value);
  const [hour, minute, second = 0] = value.split(':').map(Number);
  try {
    return dateFormatter(prop, {
      timeStyle: prop.format?.timeStyle ?? 'short',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(1970, 0, 1, hour!, minute!, second!)));
  } catch {
    return value;
  }
}

function formatDateTime(prop: PropDef, value: PropValue): string {
  if (typeof value !== 'string' || !isValidDateTime(value)) return String(value);
  try {
    const hasStyle = !!prop.format?.dateStyle || !!prop.format?.timeStyle;
    const options: Intl.DateTimeFormatOptions = {
      ...(hasStyle
        ? { dateStyle: prop.format?.dateStyle ?? 'medium', timeStyle: prop.format?.timeStyle ?? 'short' }
        : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      ...(prop.format?.timeZone ? { timeZone: prop.format.timeZone } : {}),
    };
    return dateFormatter(prop, options).format(new Date(value));
  } catch {
    return value;
  }
}

function formatTimestamp(prop: PropDef, value: PropValue): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  try {
    const hasStyle = !!prop.format?.dateStyle || !!prop.format?.timeStyle;
    return dateFormatter(prop, {
      ...(hasStyle
        ? { dateStyle: prop.format?.dateStyle ?? 'medium', timeStyle: prop.format?.timeStyle ?? 'short' }
        : { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      ...(prop.format?.timeZone ? { timeZone: prop.format.timeZone } : {}),
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function formatDuration(prop: PropDef, value: PropValue): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  const unit = prop.format?.durationUnit ?? 'minutes';
  const unitNames = { seconds: 'second', minutes: 'minute', hours: 'hour', days: 'day' } as const;
  const locale = prop.format?.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  try {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: unitNames[unit],
      unitDisplay: 'short',
      maximumFractionDigits: prop.format?.precision ?? 2,
      ...(prop.format?.precision !== undefined
        ? { minimumFractionDigits: prop.format.precision }
        : {}),
    }).format(value / durationUnitFactor(unit));
  } catch {
    return `${value} ${unit}`;
  }
}

function isEmpty(value: PropValue): boolean {
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compareValues(a: PropValue, b: PropValue, prop: PropDef | undefined): number {
  if (isEmpty(a) && isEmpty(b)) return 0;
  // empty values sort last whichever way the column is sorted
  if (isEmpty(a)) return 1;
  if (isEmpty(b)) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(b) - Number(a);
  if (prop && ['date', 'time', 'datetime'].includes(prop.type)) return compareFilterValues(a, b, prop);
  if (prop?.type === 'select') {
    return (
      prop.options.findIndex((option) => option.id === a) -
      prop.options.findIndex((option) => option.id === b)
    );
  }
  return formatValue(prop, a).localeCompare(formatValue(prop, b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function matchesFilter(
  page: PageMeta,
  rule: FilterRule,
  database: DatabaseDef,
  state?: WorkspaceState,
): boolean {
  if (rule.formula !== undefined) {
    if (!state) return false;
    const result = formulaResult(
      page,
      {
        id: `filter-${rule.id}`,
        name: 'Filter condition',
        type: 'formula',
        options: [],
        formula: rule.formula,
        formulaBindings: rule.formulaBindings ?? [],
      },
      database,
      0,
      state,
    );
    return result.error === null && result.value === true;
  }
  const prop = database.properties.find((candidate) => candidate.id === rule.prop);
  const value = valueOf(page, rule.prop, database, state);
  const text = formatValue(prop, value).toLowerCase();
  const control = rule.controlRef ? state?.pages[rule.controlRef.pageId]?.controls.find((item) => item.id === rule.controlRef!.controlId) : null;
  if (rule.controlRef && !control) return false;
  const wanted = control ? control.value : rule.value;
  switch (rule.op) {
    case 'empty':
      return isEmpty(value);
    case 'notEmpty':
      return !isEmpty(value);
    case 'checked':
      return value === true;
    case 'unchecked':
      return value !== true;
    case 'contains':
      return text.includes(String(wanted ?? '').toLowerCase());
    case 'notContains':
      return !text.includes(String(wanted ?? '').toLowerCase());
    case 'gt':
    case 'lt': {
      if (isEmpty(value) || wanted === null || wanted === '') return false;
      const order = compareFilterValues(value, wanted, prop);
      return rule.op === 'gt' ? order > 0 : order < 0;
    }
    case 'is':
    case 'isNot': {
      let same: boolean;
      if (control && wanted === '') same = value === '';
      else if (control && wanted === null) same = value === null;
      else if (Array.isArray(wanted))
        same = Array.isArray(value)
          ? wanted.length === value.length && wanted.every((item) => value.includes(item))
          : wanted.length === 0 && isEmpty(value);
      else if (wanted === null || wanted === '') same = isEmpty(value);
      else if (typeof wanted === 'boolean' || typeof value === 'boolean') same = value === wanted;
      else if (Array.isArray(value)) same = value.includes(String(wanted));
      else if (typeof value === 'number') same = value === Number(wanted);
      else if (prop?.type === 'datetime') same = Date.parse(String(value)) === Date.parse(String(wanted));
      else if (
        prop?.type === 'select' ||
        rule.prop === TITLE_PROP ||
        prop?.type === 'date' ||
        prop?.type === 'time'
      )
        same = String(value ?? '').toLowerCase() === String(wanted).toLowerCase();
      else same = text === String(wanted).toLowerCase();
      return rule.op === 'is' ? same : !same;
    }
    default:
      return true;
  }
}

function compareFilterValues(value: PropValue, wanted: PropValue, prop?: PropDef): number {
  if (typeof value === 'number') return value - Number(wanted);
  if (prop?.type === 'datetime') return Date.parse(String(value)) - Date.parse(String(wanted));
  if (prop?.type === 'date') return String(value).localeCompare(String(wanted));
  if (prop?.type === 'time') {
    const seconds = (raw: PropValue) => {
      if (typeof raw !== 'string' || !isValidTime(raw)) return Number.NaN;
      const [hour, minute, second = 0] = raw.split(':').map(Number);
      return hour! * 3600 + minute! * 60 + second!;
    };
    return seconds(value) - seconds(wanted);
  }
  return String(value).localeCompare(String(wanted));
}

export function sortRows(
  rows: PageMeta[],
  sorts: SortRule[],
  database: DatabaseDef,
  state?: WorkspaceState,
): PageMeta[] {
  if (sorts.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const sort of sorts) {
      const prop = database.properties.find((candidate) => candidate.id === sort.prop);
      const va = valueOf(a, sort.prop, database, state);
      const vb = valueOf(b, sort.prop, database, state);
      let order = compareValues(va, vb, prop);
      if (sort.dir === 'desc' && !isEmpty(va) && !isEmpty(vb)) order = -order;
      if (order !== 0) return order;
    }
    return a.order - b.order;
  });
}

export function visibleRows(
  rows: PageMeta[],
  view: ViewDef,
  database: DatabaseDef,
  state?: WorkspaceState,
  quickFilters: FilterRule[] = [],
): PageMeta[] {
  const query = (view.search ?? '').trim().toLocaleLowerCase();
  const matchesSearch = (row: PageMeta) => {
    if (!query) return true;
    if (displayTitle(row).toLocaleLowerCase().includes(query)) return true;
    return database.properties.some((prop) =>
      formatValue(prop, valueOf(row, prop.id, database, state))
        .toLocaleLowerCase()
        .includes(query),
    );
  };
  const matchesGroups = (row: PageMeta) => {
    const groups = view.filterGroups?.length
      ? view.filterGroups
      : view.filters.length
        ? [{ logic: 'and' as const, filters: view.filters }]
        : [];
    const groupMatches = groups.map((group) =>
      group.logic === 'or'
        ? group.filters.some((rule) => matchesFilter(row, rule, database, state))
        : group.filters.every((rule) => matchesFilter(row, rule, database, state)),
    );
    return view.filterGroups?.length && view.filterGroupLogic === 'or'
      ? groupMatches.some(Boolean)
      : groupMatches.every(Boolean);
  };
  const filtered = rows.filter(
    (row) =>
      matchesGroups(row) &&
      matchesSearch(row) &&
      quickFilters.every((rule) => matchesFilter(row, rule, database, state)),
  );
  return sortRows(filtered, view.sorts, database, state);
}

export interface PropertySummary {
  value: number | null;
  error: string | null;
}

// Formula failures remain visible as errors in summaries instead of being treated as blank or zero.
export function summarizeProperty(
  rows: PageMeta[],
  prop: PropDef,
  operation: SummaryOperation,
  database: DatabaseDef,
  state?: WorkspaceState,
): PropertySummary {
  const values: PropValue[] = [];
  for (const row of rows) {
    if (prop.type === 'formula' || prop.fillMode === 'calculated') {
      const result = formulaResult(row, prop, database, 0, state);
      if (result.error) return { value: null, error: result.error };
      values.push(toPropertyValue(result.value, prop, state));
    } else values.push(valueOf(row, prop.id, database, state));
  }
  if (operation === 'count')
    return {
      value: values.filter(
        (value) => value !== null && value !== '' && !(Array.isArray(value) && !value.length),
      ).length,
      error: null,
    };
  const numbers: number[] = [];
  for (const value of values) {
    if (value === null || value === '') continue;
    if (typeof value !== 'number' || !Number.isFinite(value))
      return { value: null, error: `“${prop.name}” contains a non-numeric value.` };
    numbers.push(value);
  }
  if (operation === 'sum') return { value: numbers.reduce((total, value) => total + value, 0), error: null };
  if (numbers.length === 0) return { value: null, error: null };
  if (operation === 'average')
    return { value: numbers.reduce((total, value) => total + value, 0) / numbers.length, error: null };
  if (operation === 'min') return { value: Math.min(...numbers), error: null };
  return { value: Math.max(...numbers), error: null };
}

export function conditionalFormatForRow(
  row: PageMeta,
  rules: ConditionalFormatRule[] | undefined,
  database: DatabaseDef,
  state?: WorkspaceState,
): ConditionalFormatRule | null {
  return rules?.find((rule) => rule.scope === 'row' && matchesFilter(row, rule, database, state)) ?? null;
}

export function conditionalFormatForCell(
  row: PageMeta,
  propId: string,
  rules: ConditionalFormatRule[] | undefined,
  database: DatabaseDef,
  state?: WorkspaceState,
): ConditionalFormatRule | null {
  return (
    rules?.find(
      (rule) => rule.scope === 'cell' && rule.prop === propId && matchesFilter(row, rule, database, state),
    ) ?? null
  );
}

export interface RowGroup {
  // the option id, or null for rows without a value
  key: string | null;
  label: string;
  color: ColorName;
  rows: PageMeta[];
}

// board columns: one per option in order, rows without a value come first
export function groupRows(
  rows: PageMeta[],
  propId: string | null,
  database: DatabaseDef,
  state?: WorkspaceState,
): RowGroup[] {
  const prop = database.properties.find((candidate) => candidate.id === propId);
  if (!prop) return [{ key: null, label: 'All', color: 'gray', rows }];
  const value = (row: PageMeta) => valueOf(row, prop.id, database, state);
  if (prop.type === 'checkbox') {
    return [
      {
        key: 'false',
        label: 'Not checked',
        color: 'gray',
        rows: rows.filter((row) => value(row) !== true),
      },
      {
        key: 'true',
        label: 'Checked',
        color: 'green',
        rows: rows.filter((row) => value(row) === true),
      },
    ];
  }
  const calculated = prop.type === 'formula' || prop.fillMode === 'calculated';
  if (prop.type !== 'select' && prop.type !== 'multiSelect' && !calculated)
    return [{ key: null, label: 'All', color: 'gray', rows }];
  if (prop.type === 'select' || prop.type === 'multiSelect') {
    const groups: RowGroup[] = [
      { key: null, label: `No ${prop.name.toLowerCase() || 'value'}`, color: 'gray', rows: [] },
      ...prop.options.map((option) => ({
        key: option.id,
        label: option.name,
        color: option.color,
        rows: [] as PageMeta[],
      })),
    ];
    for (const row of rows) {
      const rowValue = value(row);
      const keys = Array.isArray(rowValue) ? rowValue : typeof rowValue === 'string' ? [rowValue] : [];
      const matched = groups.filter((group) => group.key !== null && keys.includes(group.key));
      if (matched.length === 0) groups[0]!.rows.push(row);
      else for (const group of matched) group.rows.push(row);
    }
    return groups;
  }
  const groups: RowGroup[] = [
    { key: null, label: `No ${prop.name.toLowerCase() || 'value'}`, color: 'gray', rows: [] },
  ];
  for (const row of rows) {
    const rowValue = value(row);
    const key = rowValue === null || rowValue === '' ? null : String(rowValue);
    if (key === null) {
      groups[0]!.rows.push(row);
      continue;
    }
    let group = groups.find((candidate) => candidate.key === key);
    if (!group) {
      group = { key, label: formatValue(prop, rowValue), color: 'gray', rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups;
}

// keeps what still makes sense when a property changes type
export function convertValue(from: PropDef, to: PropDef, value: PropValue): PropValue {
  const converted = tryConvertValue(from, to, value);
  return converted.ok ? converted.value : null;
}

export type ValueConversion = { ok: true; value: PropValue } | { ok: false; error: string };

export function tryConvertValue(from: PropDef, to: PropDef, value: PropValue): ValueConversion {
  if (value === null || value === '') return { ok: true, value: null };
  if (to.type === 'formula' || to.type === 'createdTime' || to.type === 'lastEditedTime')
    return { ok: true, value: null };

  let candidate: PropValue;
  const text = formatValue(from, value).trim();
  if (to.type === 'image' || to.type === 'file' || to.type === 'richCanvas') {
    if (
      from.type !== to.type &&
      !(['image', 'file'].includes(from.type) && ['image', 'file'].includes(to.type))
    )
      return { ok: false, error: `“${text}” cannot be converted to ${to.type}.` };
    candidate = value;
  } else if (isNumericPropertyType(to.type)) {
    let number = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(number) && typeof value === 'string') {
      const currency = from.type === 'currency' ? (from.format?.currency ?? 'BRL') : undefined;
      const locale =
        from.format?.locale ??
        (/^\s*R\$/i.test(value) || (from.type === 'currency' && currency === 'BRL')
          ? 'pt-BR'
          : typeof navigator !== 'undefined'
            ? navigator.language
            : 'en-US');
      number = parseLocalizedNumber(value, locale, currency, true) ?? Number.NaN;
    }
    if (!Number.isFinite(number)) return { ok: false, error: `“${text}” is not a valid number.` };
    const explicitDurationUnit = typeof value === 'string' ? durationUnitFromText(value) : null;
    if (from.type === 'duration') number /= durationUnitFactor(from.format?.durationUnit ?? 'minutes');
    if (to.type === 'duration' && from.type !== 'duration')
      number *= durationUnitFactor(explicitDurationUnit ?? to.format?.durationUnit ?? 'minutes');
    if (to.type === 'percent' && from.type !== 'percent') number /= 100;
    else if (from.type === 'percent' && to.type !== 'percent') number *= 100;
    candidate = number;
  } else if (to.type === 'checkbox') {
    if (typeof value === 'boolean') candidate = value;
    else if (/^(yes|true|x|1)$/i.test(text)) candidate = true;
    else if (/^(no|false|0)$/i.test(text)) candidate = false;
    else return { ok: false, error: `“${text}” cannot be converted to a checkbox.` };
  } else if (to.type === 'date') {
    const dateText = typeof value === 'string' ? value.slice(0, 10) : '';
    if (!isValidDateKey(dateText)) return { ok: false, error: `“${text}” is not a real calendar date.` };
    candidate = dateText;
  } else if (to.type === 'time') {
    const timeText = typeof value === 'string' ? (value.match(/\d{2}:\d{2}(?::\d{2})?/)?.[0] ?? '') : '';
    if (!isValidTime(timeText)) return { ok: false, error: `“${text}” is not a valid time.` };
    candidate = timeText;
  } else if (to.type === 'datetime') {
    let dateTimeText = typeof value === 'string' ? value : '';
    if (isValidDateKey(dateTimeText)) dateTimeText = `${dateTimeText}T00:00:00.000Z`;
    if (!isValidDateTime(dateTimeText))
      return { ok: false, error: `“${text}” needs a date, time, and timezone.` };
    candidate = dateTimeText;
  } else if (to.type === 'select') {
    const sourceOptions = from.options ?? [];
    if (from.type === 'multiSelect' && Array.isArray(value) && value.length > 1)
      return { ok: false, error: 'A selection with multiple options cannot become a single select value.' };
    const sourceName =
      from.type === 'select'
        ? (sourceOptions.find((option) => option.id === value)?.name ?? text)
        : text.split(',')[0]!.trim();
    const option = to.options.find(
      (item) => item.name.toLowerCase() === sourceName.toLowerCase() || item.id === value,
    );
    if (!option) return { ok: false, error: `“${sourceName}” is not a configured option.` };
    candidate = option.id;
  } else if (to.type === 'multiSelect') {
    const sourceNames =
      from.type === 'multiSelect' && Array.isArray(value)
        ? value.map((id) => from.options.find((option) => option.id === id)?.name ?? id)
        : from.type === 'select' && typeof value === 'string'
          ? [from.options.find((option) => option.id === value)?.name ?? text]
          : text
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean);
    const converted = sourceNames.map((name) =>
      to.options.find((option) => option.name.toLowerCase() === name.toLowerCase()),
    );
    const missing = sourceNames.filter((_, index) => !converted[index]);
    if (missing.length)
      return { ok: false, error: `Unknown option${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
    candidate = [...new Set(converted.flatMap((option) => (option ? [option.id] : [])))];
  } else if (to.type === 'relation') {
    candidate = typeof value === 'string' ? [text] : Array.isArray(value) ? value : text ? [text] : [];
  } else {
    candidate = text;
  }
  const error = scalarValueError(to, candidate);
  return error ? { ok: false, error } : { ok: true, value: candidate };
}

// options a converted select needs, made from the values the rows already have
export function optionsFromValues(from: PropDef, values: PropValue[], newId: () => string): SelectOption[] {
  const names = new Map<string, string>();
  for (const value of values) {
    for (const part of formatValue(from, value).split(',')) {
      const name = part.trim();
      if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    }
  }
  return [...names.values()].slice(0, 200).map((name, index) => newOption(name, index, newId));
}

// picks the most fitting type for a column of text values, used when importing csv files
export function inferType(values: string[]): PropType {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (filled.length === 0) return 'text';
  if (filled.every((value) => /^(yes|no|true|false)$/i.test(value))) return 'checkbox';
  if (filled.every((value) => /^-?\d+(\.\d+)?$/.test(value.replace(/,/g, '')))) return 'number';
  if (
    filled.every(
      (value) =>
        !Number.isNaN(Date.parse(value)) && /\d{4}|\d{1,2} \w+ \d{2,4}|\w+ \d{1,2}, \d{4}/.test(value),
    )
  )
    return 'date';
  if (filled.every((value) => /^https?:\/\/\S+$/i.test(value))) return 'url';
  const distinct = new Set(filled.map((value) => value.toLowerCase()));
  if (filled.some((value) => value.includes(', ')) && distinct.size < Math.max(4, filled.length)) {
    const parts = new Set(
      filled.flatMap((value) => value.split(',').map((part) => part.trim().toLowerCase())),
    );
    if (parts.size <= 30) return 'multiSelect';
  }
  // a few short values that repeat look like a status or a category
  if (
    distinct.size <= 12 &&
    distinct.size <= Math.max(2, filled.length * 0.75) &&
    filled.every((value) => value.length <= 40 && value.split(/\s+/).length <= 3)
  )
    return 'select';
  return 'text';
}

export function parseCellValue(prop: PropDef, raw: string): PropValue {
  const value = raw.trim();
  if (!value) return null;
  switch (prop.type) {
    case 'number':
      return parsePropertyNumber(prop, value);
    case 'checkbox':
      return /^(yes|true)$/i.test(value);
    case 'date': {
      if (isValidDateKey(value)) return value;
      const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      if (match) {
        const key = `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
        return isValidDateKey(key) ? key : null;
      }
      return null;
    }
    case 'currency':
    case 'percent':
    case 'slider':
    case 'progress':
    case 'scale':
    case 'duration': {
      const numeric = parsePropertyNumber(prop, value, prop.type === 'duration');
      if (numeric === null) return null;
      if (prop.type === 'duration') {
        const unit = durationUnitFromText(value) ?? prop.format?.durationUnit ?? 'minutes';
        return numeric * durationUnitFactor(unit);
      }
      return prop.type === 'percent' && value.endsWith('%') ? numeric / 100 : numeric;
    }
    case 'time':
      return isValidTime(value) ? value : null;
    case 'datetime': {
      return isValidDateTime(value) ? new Date(value).toISOString() : null;
    }
    case 'select':
      return prop.options.find((option) => option.name.toLowerCase() === value.toLowerCase())?.id ?? null;
    case 'multiSelect': {
      const names = value.split(',').map((part) => part.trim().toLowerCase());
      const ids = prop.options
        .filter((option) => names.includes(option.name.toLowerCase()))
        .map((option) => option.id);
      return ids.length ? ids : null;
    }
    default:
      return value;
  }
}

function parsePropertyNumber(prop: PropDef, raw: string, allowUnitSuffix = false): number | null {
  const currency = prop.type === 'currency' ? (prop.format?.currency ?? 'BRL') : undefined;
  const locale =
    prop.format?.locale ??
    (/^\s*R\$/i.test(raw) || (prop.type === 'currency' && currency === 'BRL')
      ? 'pt-BR'
      : typeof navigator !== 'undefined'
        ? navigator.language
        : 'en-US');
  return parseLocalizedNumber(raw, locale, currency, allowUnitSuffix);
}

// builds a database schema for csv columns, the first column is the row title
export function databaseFromTable(header: string[], rows: string[][], newId: () => string): DatabaseDef {
  // frontmatter keys are case sensitive, so Tags is a property while tags stays morrow's own
  const reserved = new Set(['title', 'icon', 'kind', 'tags', 'tag', 'database', 'aliases']);
  const used = new Set<string>();
  const properties: PropDef[] = [];
  header.slice(1).forEach((rawName, offset) => {
    const column = offset + 1;
    let name = rawName.trim() || `Column ${column + 1}`;
    for (let n = 2; used.has(name.toLowerCase()) || reserved.has(name); n++)
      name = `${rawName.trim() || 'Column'} ${n}`;
    used.add(name.toLowerCase());
    const values = rows.map((row) => row[column] ?? '');
    const type = inferType(values);
    const prop: PropDef = { id: newId(), name, type, options: [] };
    if (type === 'select' || type === 'multiSelect') {
      const names = new Map<string, string>();
      for (const value of values) {
        for (const part of type === 'multiSelect' ? value.split(',') : [value]) {
          const cleaned = part.trim();
          if (cleaned && !names.has(cleaned.toLowerCase())) names.set(cleaned.toLowerCase(), cleaned);
        }
      }
      prop.options = [...names.values()].map((optionName, index) => newOption(optionName, index, newId));
    }
    properties.push(prop);
  });
  const database: DatabaseDef = { properties, views: [] };
  database.views = [newView('table', database, newId)];
  if (properties.some((prop) => prop.type === 'select'))
    database.views.push(newView('board', database, newId));
  if (properties.some((prop) => prop.type === 'date'))
    database.views.push(newView('calendar', database, newId));
  return database;
}
