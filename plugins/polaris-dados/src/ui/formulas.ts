import type { DataApiRow, DataApiSnapshot } from '../../../../src/app/plugins/dataApi';
import { computeRuntimeFormula, parseFormula } from '../engine/formula';
import type { Expr, FormulaRowRef, FormulaRuntimeValue, FormulaSpan } from '../engine/formula';

export type ReadySnapshot = Extract<DataApiSnapshot, { status: 'ready' }>;
export type ProviderProperty = ReadySnapshot['schema']['properties'][number];

export type EvaluatedCell =
  | { readonly kind: 'missing' }
  | { readonly kind: 'null' }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'list'; readonly value: readonly FormulaRuntimeValue[] }
  | { readonly kind: 'error'; readonly message: string };

const MAX_FORMULA_DEPTH = 24;
const MAX_REFERENCED_FORMULAS = 64;
const MAX_LOCAL_LIST_VALUES = 2000;
export const MAX_TABLE_PROJECTION_ROWS = 2000;

export interface FormulaDatabasePage {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
}

export type FormulaDatabaseTitleResolution =
  | { readonly status: 'resolved'; readonly title: string }
  | { readonly status: 'ambiguous'; readonly title: string; readonly competingDatabaseIds: readonly string[] }
  | { readonly status: 'unavailable' }
  | { readonly status: 'missing' };

interface ProjectedColumn {
  readonly values: FormulaRuntimeValue[];
  readonly aggregates: Map<string, ProjectionAggregateResult>;
  readonly filterIdentity?: string;
}

type ProjectedColumnResult =
  | { readonly status: 'ready'; readonly projection: ProjectedColumn }
  | { readonly status: 'error'; readonly message: string };

type ProjectionAggregateResult =
  | { readonly status: 'value'; readonly value: FormulaRuntimeValue }
  | { readonly status: 'error'; readonly message: string };

interface FilteredRows {
  readonly filterIdentity: string;
  readonly rows: readonly DataApiRow[];
  readonly tableReference: FormulaRuntimeValue[];
  readonly filterCalls: Set<string>;
}

type FilteredRowsResult =
  | { readonly status: 'ready'; readonly filteredRows: FilteredRows }
  | { readonly status: 'error'; readonly message: string };

/** A single immutable provider snapshot plus its bounded, shared table-column projections. */
export interface FormulaEvaluationScope {
  readonly snapshot: ReadySnapshot;
  readonly databaseTitle: FormulaDatabaseTitleResolution;
  readonly columns: Map<string, ProjectedColumnResult>;
  readonly filteredRows: Map<string, FilteredRowsResult>;
  readonly filteredColumns: Map<string, ProjectedColumnResult>;
  readonly projectedArrays: WeakMap<FormulaRuntimeValue[], ProjectedColumn>;
  readonly filteredRowArrays: WeakMap<FormulaRuntimeValue[], FilteredRows>;
  readonly approvedProjectionSpans: Map<string, ApprovedTableProjectionSpans>;
}

interface ApprovedTableProjectionSpans {
  readonly roots: ReadonlyMap<string, 'member' | 'string-index' | 'dynamic-index'>;
  readonly columns: ReadonlySet<string>;
  readonly rootByColumn: ReadonlyMap<string, string>;
  readonly filterCalls: ReadonlyMap<string, ApprovedTableFilter>;
  readonly filteredColumns: ReadonlyMap<string, string>;
}

type ApprovedTableFilter =
  | {
      readonly predicateName: string;
      readonly propertyColumnSpan: string;
      readonly operator: 'checked';
    }
  | {
      readonly predicateName: string;
      readonly propertyColumnSpan: string;
      readonly operator: 'equals';
      readonly literal: string;
    };

type ApprovedTableFilterPredicate =
  | { readonly predicateName: string; readonly operator: 'checked' }
  | { readonly predicateName: string; readonly operator: 'equals'; readonly literal: string };

const LOCAL_LIST_METHODS = new Set(['sum', 'average', 'avg', 'min', 'max', 'count', 'first', 'last']);

interface FormulaEvaluationBudget {
  readonly cache: Map<string, EvaluatedCell>;
  readonly visiting: Set<string>;
  evaluated: number;
}

export function resolveFormulaDatabaseTitle(
  databaseId: string,
  pages: readonly FormulaDatabasePage[],
): FormulaDatabaseTitleResolution {
  const matchingPages = pages.filter((page) => page.id === databaseId && page.kind === 'database');
  if (matchingPages.length !== 1) return { status: 'missing' };

  const title = matchingPages[0]!.title.trim();
  if (!title) return { status: 'missing' };
  const foldedTitle = title.toLocaleLowerCase();
  const sameTitle = pages.filter(
    (page) => page.kind === 'database' && page.title.trim().toLocaleLowerCase() === foldedTitle,
  );
  if (sameTitle.length !== 1) {
    return {
      status: 'ambiguous',
      title,
      competingDatabaseIds: sameTitle.map((page) => page.id).sort(),
    };
  }
  return { status: 'resolved', title };
}

export function createFormulaEvaluationScope(
  snapshot: ReadySnapshot,
  databaseTitle: FormulaDatabaseTitleResolution = { status: 'unavailable' },
): FormulaEvaluationScope {
  return {
    snapshot,
    databaseTitle,
    columns: new Map(),
    filteredRows: new Map(),
    filteredColumns: new Map(),
    projectedArrays: new WeakMap(),
    filteredRowArrays: new WeakMap(),
    approvedProjectionSpans: new Map(),
  };
}

/** Read a direct property or evaluate its formula without changing the host snapshot. */
export function evaluateCell(
  row: DataApiRow,
  properties: readonly ProviderProperty[],
  property: ProviderProperty,
  scope?: FormulaEvaluationScope,
): EvaluatedCell {
  if (property.type !== 'formula') {
    if (!Object.hasOwn(row.properties, property.id)) return { kind: 'missing' };
    try {
      return normalizeValue(toRuntimeValue(row.properties[property.id]));
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  return evaluateFormulaProperty(
    row,
    properties,
    property,
    { cache: new Map(), visiting: new Set(), evaluated: 0 },
    0,
    scope,
  );
}

function evaluateFormulaProperty(
  row: DataApiRow,
  properties: readonly ProviderProperty[],
  property: ProviderProperty,
  budget: FormulaEvaluationBudget,
  depth: number,
  scope?: FormulaEvaluationScope,
): EvaluatedCell {
  const cached = budget.cache.get(property.id);
  if (cached) return cached;
  if (budget.visiting.has(property.id)) {
    return { kind: 'error', message: `Formula cycle at “${property.name}”.` };
  }
  if (depth >= MAX_FORMULA_DEPTH) {
    return { kind: 'error', message: 'Formula references are nested too deeply.' };
  }
  if (budget.evaluated >= MAX_REFERENCED_FORMULAS) {
    return { kind: 'error', message: 'This formula references too many calculated properties.' };
  }
  if (typeof property.formula !== 'string' || !property.formula.trim()) {
    return { kind: 'error', message: `Formula “${property.name}” has no expression.` };
  }

  budget.evaluated += 1;
  budget.visiting.add(property.id);
  const projectionSpans = approvedTableProjectionSpans(property.formula, scope);
  const shadowedProjectionRoots = new Set<string>();
  const currentRow: FormulaRowRef = { formulaKind: 'row', id: row.id, databaseId: '' };
  const resolveDataProperty = (name: string): FormulaRuntimeValue => {
    const referenced = properties.find(
      (candidate) => candidate.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
    if (!referenced) throw new Error(`There is no property called “${name}”.`);
    if (referenced.type === 'formula') {
      const value = evaluateFormulaProperty(row, properties, referenced, budget, depth + 1, scope);
      if (value.kind === 'error') throw new Error(value.message);
      if (value.kind === 'missing' || value.kind === 'null') return null;
      if (value.kind === 'list') return [...value.value];
      return value.value;
    }
    if (!Object.hasOwn(row.properties, referenced.id)) return null;
    return toRuntimeValue(row.properties[referenced.id]);
  };
  const result = computeRuntimeFormula(property.formula, {
    resolveIdentifier(name, span) {
      if (name.trim().toLowerCase() === 'thisrow') return currentRow;
      const rootKey = spanKey(span);
      const rootKind = projectionSpans.roots.get(rootKey);
      if (rootKind) {
        const localProperty = properties.find(
          (candidate) => candidate.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
        );
        if (localProperty) {
          const value = resolveDataProperty(name);
          if (formulaDatabaseTitleMatches(name, scope)) {
            if (rootKind === 'member') shadowedProjectionRoots.add(rootKey);
            if (rootKind === 'string-index' && !Array.isArray(value)) {
              throw new Error(
                `Table projection “${name}” is ambiguous because a current-database property has the same name as the table.`,
              );
            }
          }
          return value;
        }
        const table = resolveTableIdentifier(name, scope);
        if (table) return table;
      }
      return resolveDataProperty(name);
    },
    resolveProperty(name) {
      return resolveDataProperty(name);
    },
    resolveMember(receiver, name, span) {
      if (
        typeof receiver === 'object' &&
        receiver !== null &&
        !Array.isArray(receiver) &&
        receiver.formulaKind === 'table'
      ) {
        if (!scope || receiver.databaseId !== scope.snapshot.databaseId) {
          throw new Error('Only the mounted database can be used for table projections.');
        }
        if (!projectionSpans.columns.has(spanKey(span))) {
          throw new Error(
            'Use table column projections directly with Sum, Average, Avg, Min, Max, or Count.',
          );
        }
        const projectedProperty = resolveProjectedProperty(properties, name);
        if (projectedProperty.type !== 'number') {
          throw new Error(
            `Table projections only support manual number columns; “${name}” is ${projectedProperty.type}.`,
          );
        }
        return projectedColumn(scope, projectedProperty);
      }
      if (Array.isArray(receiver)) {
        const filtered = scope?.filteredRowArrays.get(receiver);
        if (filtered) {
          const filterCall = projectionSpans.filteredColumns.get(spanKey(span));
          if (!filterCall || !filtered.filterCalls.has(filterCall)) {
            throw new Error('Filtered table rows only support a direct numeric-column Sum() projection.');
          }
          const projectedProperty = resolveProjectedProperty(properties, name);
          if (projectedProperty.type !== 'number') {
            throw new Error(
              `Table projections only support manual number columns; “${name}” is ${projectedProperty.type}.`,
            );
          }
          if (!scope) throw new Error('The mounted database snapshot is unavailable.');
          return projectedFilteredColumn(scope, filtered, projectedProperty);
        }
      }
      const rootKey = projectionSpans.rootByColumn.get(spanKey(span));
      if (rootKey && shadowedProjectionRoots.has(rootKey)) {
        throw new Error(
          `Table projection “${name}” is ambiguous because a current-database property has the same name as the table.`,
        );
      }
      if (receiver !== currentRow) {
        throw new Error('Only the current row supports property access in a database formula.');
      }
      return resolveDataProperty(name);
    },
    invokeMethod(receiver, name, arguments_, evaluateArgument, span) {
      if (Array.isArray(receiver)) {
        const projection = scope?.projectedArrays.get(receiver);
        if (projection) return aggregateProjection(projection, name, arguments_.length);
      }
      if (
        typeof receiver === 'object' &&
        receiver !== null &&
        !Array.isArray(receiver) &&
        receiver.formulaKind === 'table'
      ) {
        if (name.toLowerCase() !== 'filter') {
          throw new Error(
            'Tables only support a direct CurrentValue filter followed by a numeric-column Sum() projection.',
          );
        }
        const filterCall = projectionSpans.filterCalls.get(spanKey(span));
        if (!filterCall || !scope || receiver.databaseId !== scope.snapshot.databaseId) {
          throw new Error(
            'Table filters only support a direct CurrentValue checkbox or text-equality projection.',
          );
        }
        if (arguments_.length !== 1) throw new Error('Filter() takes exactly one CurrentValue predicate.');
        return filteredTableRows(
          scope,
          properties,
          filterCall,
          spanKey(span),
          arguments_[0]!,
          evaluateArgument,
        );
      }
      return invokeLocalListMethod(receiver, name, arguments_);
    },
  });

  budget.visiting.delete(property.id);
  const evaluated = result.error
    ? { kind: 'error' as const, message: result.error }
    : normalizeValue(result.value);
  budget.cache.set(property.id, evaluated);
  return evaluated;
}

function resolveTableIdentifier(
  name: string,
  scope: FormulaEvaluationScope | undefined,
): FormulaRuntimeValue | null {
  if (!scope) return null;
  const foldedName = name.trim().toLocaleLowerCase();
  const resolution = scope.databaseTitle;
  if (resolution.status === 'ambiguous' && resolution.title.toLocaleLowerCase() === foldedName) {
    throw new Error(
      `Table name “${name}” is ambiguous in this workspace; the formula can only project the mounted database.`,
    );
  }
  if (resolution.status === 'resolved' && resolution.title.toLocaleLowerCase() === foldedName) {
    return { formulaKind: 'table', databaseId: scope.snapshot.databaseId };
  }
  // Without a page title, preserve the old property-resolution path.
  return null;
}

/** Checks an already-read page catalog without triggering its ambiguous-title diagnostic. */
function formulaDatabaseTitleMatches(name: string, scope: FormulaEvaluationScope | undefined): boolean {
  if (!scope) return false;
  const resolution = scope.databaseTitle;
  if (resolution.status !== 'resolved' && resolution.status !== 'ambiguous') return false;
  return resolution.title.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();
}

function resolveProjectedProperty(properties: readonly ProviderProperty[], name: string): ProviderProperty {
  const matches = properties.filter(
    (candidate) => candidate.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  if (matches.length > 1) throw new Error(`Column name “${name}” is ambiguous in the mounted database.`);
  if (matches.length === 0) throw new Error(`There is no column called “${name}” in the mounted database.`);
  return matches[0]!;
}

function projectedColumn(scope: FormulaEvaluationScope, property: ProviderProperty): FormulaRuntimeValue[] {
  const cached = scope.columns.get(property.id);
  if (cached?.status === 'error') throw new Error(cached.message);
  if (cached?.status === 'ready') return cached.projection.values;
  if (scope.snapshot.rows.length > MAX_TABLE_PROJECTION_ROWS) {
    const message = `Table projections are limited to ${MAX_TABLE_PROJECTION_ROWS} rows.`;
    scope.columns.set(property.id, { status: 'error', message });
    throw new Error(message);
  }

  const values: FormulaRuntimeValue[] = [];
  try {
    for (const row of scope.snapshot.rows) {
      const rowProperties = row.properties;
      values.push(
        Object.hasOwn(rowProperties, property.id) ? toRuntimeValue(rowProperties[property.id]) : null,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.columns.set(property.id, { status: 'error', message });
    throw new Error(message, { cause: error });
  }
  const projection: ProjectedColumn = { values, aggregates: new Map() };
  scope.columns.set(property.id, { status: 'ready', projection });
  scope.projectedArrays.set(values, projection);
  return values;
}

function filteredTableRows(
  scope: FormulaEvaluationScope,
  properties: readonly ProviderProperty[],
  filter: ApprovedTableFilter,
  filterCallKey: string,
  predicate: Expr,
  evaluate: (expression: Expr, currentValue?: FormulaRuntimeValue) => FormulaRuntimeValue,
): FormulaRuntimeValue[] {
  const currentValueExpression = filterCurrentValueExpression(predicate, filter);
  if (!currentValueExpression || currentValueExpression.kind !== 'identifier') {
    throw new Error('Filter() needs a direct CurrentValue checkbox or text-equality predicate.');
  }
  const currentValueSentinel: FormulaRowRef = {
    formulaKind: 'row',
    id: 'table-filter-current-value-sentinel',
    databaseId: scope.snapshot.databaseId,
  };
  if (evaluate(currentValueExpression, currentValueSentinel) !== currentValueSentinel) {
    throw new Error('Filter() cannot use an alias that shadows the built-in CurrentValue.');
  }

  const predicateProperty = resolveProjectedProperty(properties, filter.predicateName);
  if (filter.operator === 'checked' && predicateProperty.type !== 'checkbox') {
    throw new Error(
      `Table filters only support manual checkbox columns for direct predicates; “${filter.predicateName}” is ${predicateProperty.type}.`,
    );
  }
  if (
    filter.operator === 'equals' &&
    predicateProperty.type !== 'text' &&
    predicateProperty.type !== 'select'
  ) {
    throw new Error(
      `Table text filters only support manual text or select columns; “${filter.predicateName}” is ${predicateProperty.type}.`,
    );
  }

  const filterIdentity = tableFilterIdentity(predicateProperty, filter);
  const cached = scope.filteredRows.get(filterIdentity);
  if (cached?.status === 'error') throw new Error(cached.message);
  if (cached?.status === 'ready') {
    cached.filteredRows.filterCalls.add(filterCallKey);
    return cached.filteredRows.tableReference;
  }
  if (scope.snapshot.rows.length > MAX_TABLE_PROJECTION_ROWS) {
    const message = `Table filters are limited to ${MAX_TABLE_PROJECTION_ROWS} rows.`;
    scope.filteredRows.set(filterIdentity, { status: 'error', message });
    throw new Error(message);
  }

  const rows: DataApiRow[] = [];
  const optionNamesById =
    filter.operator === 'equals' && predicateProperty.type === 'select'
      ? new Map<string, string | null>()
      : null;
  if (optionNamesById) {
    for (const option of predicateProperty.options) {
      const existingName = optionNamesById.get(option.id);
      if (existingName === undefined) optionNamesById.set(option.id, option.name);
      else if (existingName !== null && existingName !== option.name) optionNamesById.set(option.id, null);
    }
  }
  try {
    for (const row of scope.snapshot.rows) {
      const rowProperties = row.properties;
      if (filter.operator === 'checked') {
        if (!Object.hasOwn(rowProperties, predicateProperty.id)) {
          throw new Error(`Filter predicate “${filter.predicateName}” is missing for row “${row.id}”.`);
        }
        const value = rowProperties[predicateProperty.id];
        if (typeof value !== 'boolean') {
          throw new Error(
            `Filter predicate “${filter.predicateName}” must be a non-null boolean for row “${row.id}”.`,
          );
        }
        if (value) rows.push(row);
        continue;
      }

      if (!Object.hasOwn(rowProperties, predicateProperty.id)) continue;
      const value = rowProperties[predicateProperty.id];
      if (value === null) continue;
      if (typeof value !== 'string') {
        throw new Error(`Filter predicate “${filter.predicateName}” must contain text for row “${row.id}”.`);
      }
      const comparable = optionNamesById ? optionNamesById.get(value) : value;
      if (optionNamesById) {
        if (comparable === undefined) {
          throw new Error(
            `Filter predicate “${filter.predicateName}” has an unknown select option for row “${row.id}”.`,
          );
        }
        if (comparable === null) {
          throw new Error(
            `Filter predicate “${filter.predicateName}” has conflicting labels for select option ID “${value}” in row “${row.id}”.`,
          );
        }
      }
      if (comparable === filter.literal) rows.push(row);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.filteredRows.set(filterIdentity, { status: 'error', message });
    throw new Error(message, { cause: error });
  }

  const filteredRows: FilteredRows = {
    filterIdentity,
    rows,
    tableReference: new Array<FormulaRuntimeValue>(rows.length).fill(null),
    filterCalls: new Set([filterCallKey]),
  };
  scope.filteredRows.set(filterIdentity, { status: 'ready', filteredRows });
  scope.filteredRowArrays.set(filteredRows.tableReference, filteredRows);
  return filteredRows.tableReference;
}

function filterCurrentValueExpression(predicate: Expr, filter: ApprovedTableFilter): Expr | null {
  if (filter.operator === 'checked') {
    if (
      predicate.kind !== 'member' ||
      predicate.object.kind !== 'identifier' ||
      predicate.object.name.toLowerCase() !== 'currentvalue'
    ) {
      return null;
    }
    return predicate.object;
  }

  if (
    predicate.kind !== 'binary' ||
    predicate.op !== '==' ||
    predicate.left.kind !== 'member' ||
    predicate.left.object.kind !== 'identifier' ||
    predicate.left.object.name.toLowerCase() !== 'currentvalue' ||
    predicate.right.kind !== 'literal' ||
    typeof predicate.right.value !== 'string' ||
    predicate.right.value !== filter.literal
  ) {
    return null;
  }
  return predicate.left.object;
}

function tableFilterIdentity(property: ProviderProperty, filter: ApprovedTableFilter): string {
  return JSON.stringify([
    property.id,
    property.type,
    filter.operator,
    filter.operator === 'equals' ? filter.literal : null,
  ]);
}

function projectedFilteredColumn(
  scope: FormulaEvaluationScope,
  filteredRows: FilteredRows,
  property: ProviderProperty,
): FormulaRuntimeValue[] {
  const cacheKey = `${filteredRows.filterIdentity}\u0000${property.id}`;
  const cached = scope.filteredColumns.get(cacheKey);
  if (cached?.status === 'error') throw new Error(cached.message);
  if (cached?.status === 'ready') return cached.projection.values;
  if (scope.snapshot.rows.length > MAX_TABLE_PROJECTION_ROWS) {
    const message = `Table filters are limited to ${MAX_TABLE_PROJECTION_ROWS} rows.`;
    scope.filteredColumns.set(cacheKey, { status: 'error', message });
    throw new Error(message);
  }

  const values: FormulaRuntimeValue[] = [];
  try {
    for (const row of filteredRows.rows) {
      const rowProperties = row.properties;
      values.push(
        Object.hasOwn(rowProperties, property.id) ? toRuntimeValue(rowProperties[property.id]) : null,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scope.filteredColumns.set(cacheKey, { status: 'error', message });
    throw new Error(message, { cause: error });
  }

  const projection: ProjectedColumn = {
    values,
    aggregates: new Map(),
    filterIdentity: filteredRows.filterIdentity,
  };
  scope.filteredColumns.set(cacheKey, { status: 'ready', projection });
  scope.projectedArrays.set(values, projection);
  return values;
}

function aggregateProjection(
  projection: ProjectedColumn,
  name: string,
  argumentCount: number,
): FormulaRuntimeValue {
  const method = name.toLocaleLowerCase();
  if (!['sum', 'average', 'avg', 'min', 'max', 'count'].includes(method)) {
    throw new Error(
      `${name}() is not available for table columns; use Sum, Average, Avg, Min, Max, or Count.`,
    );
  }
  if (projection.filterIdentity && method !== 'sum') {
    throw new Error('Filtered table projections only support Sum().');
  }
  if (argumentCount !== 0) throw new Error(`${name}() takes no arguments.`);
  const cached = projection.aggregates.get(method);
  if (cached?.status === 'error') throw new Error(cached.message);
  if (cached?.status === 'value') return cached.value;
  try {
    const value = invokeLocalListMethod(projection.values, name, []);
    projection.aggregates.set(method, { status: 'value', value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    projection.aggregates.set(method, { status: 'error', message });
    throw new Error(message, { cause: error });
  }
}

function approvedTableProjectionSpans(
  source: string,
  scope: FormulaEvaluationScope | undefined,
): ApprovedTableProjectionSpans {
  const cached = scope?.approvedProjectionSpans.get(source);
  if (cached) return cached;
  const roots = new Map<string, 'member' | 'string-index' | 'dynamic-index'>();
  const columns = new Set<string>();
  const rootByColumn = new Map<string, string>();
  const filterCalls = new Map<string, ApprovedTableFilter>();
  const filteredColumns = new Map<string, string>();
  let expression: Expr | null = null;
  try {
    expression = parseFormula(source);
  } catch {
    // The runtime parser provides the existing syntax diagnostic.
  }
  if (expression) {
    const addColumnReceiver = (candidate: Expr, aggregateMethod: string) => {
      if (candidate.kind === 'member') {
        const propertyColumnSpan = spanKey({ start: candidate.nameStart, end: candidate.nameEnd });
        if (candidate.object.kind === 'identifier') {
          addProjectionSpans(
            candidate.object,
            { start: candidate.nameStart, end: candidate.nameEnd },
            'member',
          );
          return;
        }
        const filterCall = candidate.object;
        if (
          filterCall.kind !== 'call' ||
          filterCall.callee.kind !== 'member' ||
          filterCall.callee.name.toLowerCase() !== 'filter' ||
          filterCall.callee.object.kind !== 'identifier'
        ) {
          return;
        }
        const rootKey = spanKey(filterCall.callee.object);
        roots.set(rootKey, 'member');
        if (aggregateMethod.toLowerCase() !== 'sum' || filterCall.args.length !== 1) return;
        const predicate = filterCall.args[0]!;
        const approvedPredicate = approvedTableFilterPredicate(predicate);
        if (!approvedPredicate) return;
        const filterCallKey = spanKey(filterCall.callee);
        const filter = { ...approvedPredicate, propertyColumnSpan };
        filterCalls.set(filterCallKey, filter);
        filteredColumns.set(propertyColumnSpan, filterCallKey);
        columns.add(propertyColumnSpan);
        rootByColumn.set(propertyColumnSpan, rootKey);
      } else if (
        candidate.kind === 'call' &&
        candidate.callee.kind === 'identifier' &&
        candidate.callee.name.toLowerCase() === '__index' &&
        candidate.args[1]
      ) {
        const key = candidate.args[1];
        if (key.kind === 'literal' && typeof key.value === 'number') return;
        if (key.kind === 'literal' && typeof key.value !== 'string') return;
        if (candidate.args[0]) {
          addProjectionSpans(
            candidate.args[0],
            key,
            key.kind === 'literal' ? 'string-index' : 'dynamic-index',
          );
        }
      }
    };
    const addProjectionSpans = (
      root: Expr,
      column: FormulaSpan,
      kind: 'member' | 'string-index' | 'dynamic-index',
    ) => {
      const columnKey = spanKey(column);
      columns.add(columnKey);
      if (root.kind === 'identifier') {
        const rootKey = spanKey(root);
        roots.set(rootKey, kind);
        rootByColumn.set(columnKey, rootKey);
      }
    };
    const visit = (node: Expr): void => {
      if (node.kind === 'call') {
        if (
          node.callee.kind === 'member' &&
          ['sum', 'average', 'avg', 'min', 'max', 'count'].includes(node.callee.name.toLowerCase())
        ) {
          addColumnReceiver(node.callee.object, node.callee.name);
        }
        if (node.callee.kind === 'member') visit(node.callee.object);
        else if (node.callee.kind !== 'identifier') visit(node.callee);
        for (const argument of node.args) visit(argument);
        return;
      }
      if (node.kind === 'member') {
        visit(node.object);
        return;
      }
      if (node.kind === 'binary') {
        visit(node.left);
        visit(node.right);
        return;
      }
      if (node.kind === 'unary') {
        visit(node.arg);
        return;
      }
      if (node.kind === 'list') for (const item of node.items) visit(item);
    };
    visit(expression);
  }
  const approved = { roots, columns, rootByColumn, filterCalls, filteredColumns };
  scope?.approvedProjectionSpans.set(source, approved);
  return approved;
}

function spanKey(span: FormulaSpan): string {
  return `${span.start}:${span.end}`;
}

function approvedTableFilterPredicate(predicate: Expr): ApprovedTableFilterPredicate | null {
  if (
    predicate.kind === 'member' &&
    predicate.object.kind === 'identifier' &&
    predicate.object.name.toLowerCase() === 'currentvalue'
  ) {
    return { predicateName: predicate.name, operator: 'checked' };
  }
  if (
    predicate.kind === 'binary' &&
    predicate.op === '==' &&
    predicate.left.kind === 'member' &&
    predicate.left.object.kind === 'identifier' &&
    predicate.left.object.name.toLowerCase() === 'currentvalue' &&
    predicate.right.kind === 'literal' &&
    typeof predicate.right.value === 'string'
  ) {
    return {
      predicateName: predicate.left.name,
      operator: 'equals',
      literal: predicate.right.value,
    };
  }
  return null;
}

function toRuntimeValue(value: unknown): FormulaRuntimeValue {
  if (Array.isArray(value)) return value.map((item) => toRuntimeValue(item));
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  throw new Error('The property value has an unsupported shape.');
}

function normalizeValue(value: FormulaRuntimeValue): EvaluatedCell {
  if (value === null) return { kind: 'null' };
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { kind: 'number', value }
      : { kind: 'error', message: 'The formula produced a non-finite number.' };
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'string') return { kind: 'text', value };
  if (Array.isArray(value)) {
    return containsUnsupportedReference(value)
      ? { kind: 'error', message: 'This table does not display row references or tables.' }
      : { kind: 'list', value };
  }
  return { kind: 'error', message: 'This table does not display row references or tables.' };
}

function containsUnsupportedReference(value: FormulaRuntimeValue): boolean {
  if (Array.isArray(value)) return value.some(containsUnsupportedReference);
  return typeof value === 'object' && value !== null;
}

function invokeLocalListMethod(
  receiver: FormulaRuntimeValue,
  name: string,
  arguments_: readonly unknown[],
): FormulaRuntimeValue {
  const method = name.toLowerCase();
  if (!Array.isArray(receiver)) {
    throw new Error(`${name}() needs a local list of values.`);
  }
  if (!LOCAL_LIST_METHODS.has(method)) {
    throw new Error(`There is no list method called “${name}”.`);
  }
  if (arguments_.length !== 0) {
    throw new Error(`${name}() takes no arguments.`);
  }
  if (receiver.length > MAX_LOCAL_LIST_VALUES) {
    throw new Error(`${name}() is limited to ${MAX_LOCAL_LIST_VALUES} values.`);
  }

  if (method === 'count') return receiver.filter((value) => value !== null).length;
  if (method === 'first') return receiver[0] ?? null;
  if (method === 'last') return receiver[receiver.length - 1] ?? null;
  if (receiver.length === 0) return method === 'sum' ? 0 : null;

  const numbers = receiver.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${name}() only accepts finite numbers.`);
    }
    return value;
  });
  if (method === 'min') return Math.min(...numbers);
  if (method === 'max') return Math.max(...numbers);

  const total = numbers.reduce((sum, value) => {
    const next = sum + value;
    if (!Number.isFinite(next)) throw new Error(`${name}() produced a non-finite number.`);
    return next;
  }, 0);
  return method === 'sum' ? total : total / numbers.length;
}
