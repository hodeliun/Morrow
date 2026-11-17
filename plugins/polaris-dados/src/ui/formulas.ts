import type { DataApiRow, DataApiSnapshot } from '../../../../src/app/plugins/dataApi';
import { computeRuntimeFormula } from '../engine/formula';
import type { FormulaRuntimeValue } from '../engine/formula';

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

interface FormulaEvaluationBudget {
  readonly cache: Map<string, EvaluatedCell>;
  readonly visiting: Set<string>;
  evaluated: number;
}

/** Read a direct property or evaluate its formula without changing the host snapshot. */
export function evaluateCell(
  row: DataApiRow,
  properties: readonly ProviderProperty[],
  property: ProviderProperty,
): EvaluatedCell {
  if (property.type !== 'formula') {
    if (!Object.hasOwn(row.properties, property.id)) return { kind: 'missing' };
    try {
      return normalizeValue(toRuntimeValue(row.properties[property.id]));
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
  }

  return evaluateFormulaProperty(row, properties, property, { cache: new Map(), visiting: new Set(), evaluated: 0 }, 0);
}

function evaluateFormulaProperty(
  row: DataApiRow,
  properties: readonly ProviderProperty[],
  property: ProviderProperty,
  budget: FormulaEvaluationBudget,
  depth: number,
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
  const result = computeRuntimeFormula(property.formula, {
    resolveIdentifier(name) {
      const referenced = properties.find(
        (candidate) => candidate.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (!referenced) throw new Error(`There is no property called “${name}”.`);
      if (referenced.type === 'formula') {
        const value = evaluateFormulaProperty(row, properties, referenced, budget, depth + 1);
        if (value.kind === 'error') throw new Error(value.message);
        if (value.kind === 'missing') return null;
        if (value.kind === 'null') return null;
        if (value.kind === 'list') return [...value.value];
        return value.value;
      }
      if (!Object.hasOwn(row.properties, referenced.id)) return null;
      return toRuntimeValue(row.properties[referenced.id]);
    },
  });

  budget.visiting.delete(property.id);
  const evaluated = result.error ? { kind: 'error' as const, message: result.error } : normalizeValue(result.value);
  budget.cache.set(property.id, evaluated);
  return evaluated;
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
  if (Array.isArray(value)) return { kind: 'list', value };
  return { kind: 'error', message: 'This table does not display row references or tables.' };
}
