import { applyCommand } from './commands';
import type { Command } from './commands';
import { formulaOutputValue, formulaResult } from './database';
import type { FormulaResult } from './database';
import type {
  ActionFormulaDef,
  DatabaseDef,
  FormulaReferenceBinding,
  PageId,
  PageMeta,
  PropDef,
  PropValue,
  TableActionStep,
  WorkspaceState,
} from './model';
import { fail, ok } from './result';
import type { Result } from './result';
import { isComputedProperty, propertyValueError } from './typedValues';
import { childrenOf, isEffectivelyTrashed } from './tree';

export const MAX_TABLE_ACTION_STEPS = 12;
export const MAX_TABLE_ACTION_ROWS = 200;
export const MAX_TABLE_ACTION_ROWS_PER_STEP = 100;
export const MAX_TABLE_ACTION_AFFECTED_ROWS = 500;

export interface TableActionAvailability {
  disabled: boolean;
  reason: string | null;
}

export interface TableActionPreviewStep {
  id: string;
  type: TableActionStep['type'];
  rows: PageMeta[];
  controlNames: string[];
}

export interface ActionRecordChange {
  id: PageId;
  before: PageMeta | null;
  after: PageMeta | null;
}

export interface TableActionPlan {
  databaseId: PageId;
  rowId: PageId;
  propertyId: string;
  label: string;
  baseState: WorkspaceState;
  commands: Command[];
  records: ActionRecordChange[];
  steps: TableActionPreviewStep[];
  writes: number;
}

export function tableActionAvailability(
  state: WorkspaceState,
  databaseId: PageId,
  rowId: PageId,
  prop: PropDef,
): TableActionAvailability {
  const action = prop.action;
  if (prop.type !== 'button' || !action) return { disabled: true, reason: 'This action is not configured.' };
  if (action.steps.length === 0) return { disabled: true, reason: 'Add an action step first.' };
  if (!action.disabled?.source.trim()) return { disabled: false, reason: null };
  const database = state.pages[databaseId];
  const row = state.pages[rowId];
  if (!database?.database || !row || row.parentId !== databaseId)
    return { disabled: true, reason: 'The table or row is no longer available.' };
  const result = evaluateFormula(
    action.disabled,
    row,
    database.database,
    state,
    'formula',
    'button-disabled',
  );
  if (result.error) return { disabled: true, reason: result.error };
  if (typeof result.value !== 'boolean')
    return { disabled: true, reason: 'The disabled condition must return true or false.' };
  return result.value
    ? { disabled: true, reason: 'The disabled condition is true for this row.' }
    : { disabled: false, reason: null };
}

export function planTableAction(
  state: WorkspaceState,
  databaseId: PageId,
  rowId: PageId,
  propId: string,
  newId: () => PageId,
  now: number,
): Result<TableActionPlan> {
  const databasePage = state.pages[databaseId];
  const clickedRow = state.pages[rowId];
  const prop = databasePage?.database?.properties.find((candidate) => candidate.id === propId);
  if (
    databasePage?.kind !== 'database' ||
    !databasePage.database ||
    !prop ||
    prop.type !== 'button' ||
    !prop.action ||
    !clickedRow ||
    clickedRow.parentId !== databaseId ||
    isEffectivelyTrashed(state.pages, rowId) ||
    isEffectivelyTrashed(state.pages, databaseId)
  )
    return fail('This action, table, or row is no longer available.');
  const availability = tableActionAvailability(state, databaseId, rowId, prop);
  if (availability.disabled) return fail(availability.reason ?? 'This action is disabled.');
  if (prop.action.steps.length > MAX_TABLE_ACTION_STEPS)
    return fail(`An action can contain at most ${MAX_TABLE_ACTION_STEPS} steps.`);

  let draft = state;
  const commands: Command[] = [];
  const changed = new Set<PageId>();
  const steps: TableActionPreviewStep[] = [];
  let addedRows = 0;
  let affectedRows = 0;
  const apply = (command: Command): Result<null> => {
    const result = applyCommand(draft, command);
    if (!result.ok) return result;
    draft = result.value.state;
    commands.push(command);
    for (const id of result.value.changes.pages) changed.add(id);
    return ok(null);
  };

  for (const step of prop.action.steps) {
    if (step.type === 'addRows') {
      const countRow = draft.pages[rowId] ?? clickedRow;
      const countResult = evaluateFormula(
        step.count,
        countRow,
        databasePage.database,
        draft,
        'number',
        `${step.id}:count`,
      );
      if (countResult.error) return fail(`Add rows step: ${countResult.error}`);
      const count = countResult.value;
      if (
        typeof count !== 'number' ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_TABLE_ACTION_ROWS_PER_STEP
      )
        return fail(`Add rows count must be a whole number from 1 to ${MAX_TABLE_ACTION_ROWS_PER_STEP}.`);
      addedRows += count;
      affectedRows += count;
      if (addedRows > MAX_TABLE_ACTION_ROWS)
        return fail(`An action can add at most ${MAX_TABLE_ACTION_ROWS} rows.`);
      if (affectedRows > MAX_TABLE_ACTION_AFFECTED_ROWS)
        return fail(`An action can affect at most ${MAX_TABLE_ACTION_AFFECTED_ROWS} rows.`);
      const previewRows: PageMeta[] = [];
      for (let index = 1; index <= count; index++) {
        const id = newId();
        const formulaRow = draft.pages[rowId] ?? clickedRow;
        const values: Record<string, PropValue> = {};
        for (const [propertyId, formula] of Object.entries(step.values)) {
          const target = databasePage.database.properties.find((candidate) => candidate.id === propertyId);
          if (!target || target.type === 'button' || isComputedProperty(target) || target.relation?.isInverse)
            return fail(`The add rows step refers to a column that cannot be edited.`);
          const calculated = evaluateFormula(
            formula,
            formulaRow,
            databasePage.database,
            draft,
            target,
            `${step.id}:${propertyId}:${index}`,
            index,
          );
          if (calculated.error) return fail(`Add rows step, ${target.name}: ${calculated.error}`);
          const value = actionValue(formulaOutputValue(calculated.value, target, draft), target);
          const error = propertyValueError(target, value);
          if (error) return fail(`Add rows step, ${error}`);
          values[propertyId] = value;
        }
        const titleResult = evaluateFormula(
          step.title,
          formulaRow,
          databasePage.database,
          draft,
          { id: `${step.id}:title`, name: 'Title', type: 'text', options: [] },
          `${step.id}:title:${index}`,
          index,
        );
        if (titleResult.error) return fail(`Add rows title: ${titleResult.error}`);
        const title = formulaOutputValue(
          titleResult.value,
          { id: 'title', name: 'Title', type: 'text', options: [] },
          draft,
        );
        const result = apply({
          type: 'page.create',
          id,
          parentId: databaseId,
          now,
          title: title === null ? '' : String(title),
          properties: values,
        });
        if (!result.ok) return result;
        const created = draft.pages[id];
        if (created) previewRows.push(created);
      }
      steps.push({ id: step.id, type: step.type, rows: previewRows, controlNames: [] });
      continue;
    }

    if (step.type === 'modifyRows') {
      const candidates =
        step.target === 'currentRow'
          ? [draft.pages[rowId]].filter((row): row is PageMeta => Boolean(row))
          : childrenOf(draft.pages, databaseId).filter((row) => !isEffectivelyTrashed(draft.pages, row.id));
      const targets: PageMeta[] = [];
      for (const candidate of candidates) {
        if (step.target === 'matchingRows') {
          if (!step.where?.source.trim()) return fail('Choose a matching condition for Modify rows.');
          const condition = evaluateFormula(
            step.where,
            candidate,
            databasePage.database,
            draft,
            'formula',
            `${step.id}:where:${candidate.id}`,
          );
          if (condition.error) return fail(`Modify rows condition: ${condition.error}`);
          if (typeof condition.value !== 'boolean')
            return fail('Modify rows condition must return true or false.');
          if (!condition.value) continue;
        }
        targets.push(candidate);
      }
      affectedRows += targets.length;
      if (affectedRows > MAX_TABLE_ACTION_AFFECTED_ROWS)
        return fail(`An action can affect at most ${MAX_TABLE_ACTION_AFFECTED_ROWS} rows.`);
      const previewRows: PageMeta[] = [];
      for (const target of targets) {
        const values: Record<string, PropValue> = {};
        for (const [propertyId, formula] of Object.entries(step.values)) {
          const targetProp = databasePage.database.properties.find(
            (candidate) => candidate.id === propertyId,
          );
          if (
            !targetProp ||
            targetProp.type === 'button' ||
            isComputedProperty(targetProp) ||
            targetProp.relation?.isInverse
          )
            return fail('The Modify rows step refers to a column that cannot be edited.');
          const calculated = evaluateFormula(
            formula,
            target,
            databasePage.database,
            draft,
            targetProp,
            `${step.id}:${propertyId}:${target.id}`,
          );
          if (calculated.error) return fail(`Modify rows, ${targetProp.name}: ${calculated.error}`);
          const value = actionValue(formulaOutputValue(calculated.value, targetProp, draft), targetProp);
          const error = propertyValueError(targetProp, value);
          if (error) return fail(`Modify rows, ${error}`);
          values[propertyId] = value;
        }
        if (Object.keys(values).length === 0) continue;
        const result = apply({ type: 'page.setProperties', id: target.id, values, now });
        if (!result.ok) return result;
        const updated = draft.pages[target.id];
        if (updated) previewRows.push(updated);
      }
      steps.push({ id: step.id, type: step.type, rows: previewRows, controlNames: [] });
      continue;
    }

    const controlNames: string[] = [];
    for (const controlId of step.controlIds) {
      const control = databasePage.controls.find((item) => item.id === controlId);
      if (!control) return fail('A reset controls step refers to a control that is no longer available.');
      controlNames.push(control.name);
      const result = apply({ type: 'page.control.reset', id: databaseId, controlId, now });
      if (!result.ok) return result;
    }
    steps.push({ id: step.id, type: step.type, rows: [], controlNames });
  }

  const records = [...changed].map((id) => ({
    id,
    before: state.pages[id] ?? null,
    after: draft.pages[id] ?? null,
  }));
  if (records.length === 0) return fail('This action would not change any rows or controls.');
  if (records.length > MAX_TABLE_ACTION_AFFECTED_ROWS + 20)
    return fail('This action affects too many records.');
  return ok({
    databaseId,
    rowId,
    propertyId: prop.id,
    label: prop.action.label,
    baseState: state,
    commands,
    records,
    steps,
    writes: records.filter(
      (record) => record.before === null || JSON.stringify(record.before) !== JSON.stringify(record.after),
    ).length,
  });
}

// Action results are stored, so currency output must match its displayed decimal precision.
// This also avoids serializing binary arithmetic artifacts such as 33.339999999999996.
function actionValue(value: PropValue, prop: PropDef): PropValue {
  if (prop.type !== 'currency' || typeof value !== 'number') return value;
  const precision = prop.format?.precision ?? 2;
  if (!Number.isInteger(precision) || precision < 0 || precision > 8) return value;
  return Number(value.toFixed(precision));
}

function evaluateFormula(
  formula: ActionFormulaDef,
  row: PageMeta,
  database: DatabaseDef,
  state: WorkspaceState,
  target: PropDef | 'formula' | 'number',
  id: string,
  currentValue?: number,
): FormulaResult {
  const targetProp =
    typeof target === 'string'
      ? {
          id,
          name: 'Action expression',
          type: target === 'number' ? ('number' as const) : ('formula' as const),
          options: [],
        }
      : target;
  const prefix = currentValue === undefined ? '' : `FormulaMap([${currentValue}], (`;
  const suffix = currentValue === undefined ? '' : '))';
  const source = formula.source.trim() ? `${prefix}${formula.source}${suffix}` : '';
  const bindings: FormulaReferenceBinding[] = formula.bindings.map((binding) => ({
    ...binding,
    ...(currentValue === undefined
      ? {}
      : { start: binding.start + prefix.length, end: binding.end + prefix.length }),
  }));
  const evaluationProp =
    currentValue === undefined ? targetProp : { ...targetProp, type: 'formula' as const };
  const result = formulaResult(
    row,
    { ...evaluationProp, formula: source, formulaBindings: bindings },
    database,
    0,
    state,
  );
  if (result.error || currentValue === undefined) return result;
  const first = Array.isArray(result.value) ? result.value[0] : null;
  return { value: first ?? null, error: null };
}
