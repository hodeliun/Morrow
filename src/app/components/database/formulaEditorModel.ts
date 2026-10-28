import type { DatabaseDef, FormulaReferenceBinding, PageId, PropDef, WorkspaceState } from '../../../core/model';
import { displayTitle } from '../../../core/model';
import { parseFormula } from '../../../core/formula';
import type { Expr } from '../../../core/formula';
import { relationConfig } from '../../../core/relations';
import { isEffectivelyTrashed } from '../../../core/tree';

export const FORMULA_FUNCTIONS =
  'If, IfError, Switch, WithName, Contains, Unique, List, Sequence, FormulaMap, ForEach, First, IsBlank, ToNumber, ToText, Round, Floor, Mod, Sum, Average, Count, Min, Max, Filter, Empty, Ceil, Abs, Sqrt, Length, Concat, Join, Upper, Lower, Replace, Slice, Today, Now, DateAdd, DateBetween, Year, Month, Day';

export const FORMULA_EXAMPLES = [
  'thisRow.`Related rows`.Amount',
  'IfError(thisRow.Amount / thisRow.Count, 0)',
  '`Transactions`.Filter(CurrentValue.Status = "Paid").Amount.Sum()',
  'FormulaMap([1, 2, 3], CurrentValue * 2)',
  'prop("Price") * prop("Count")',
  'if(prop("Done"), "✅", "⏳")',
  'dateBetween(prop("Due"), today(), "days")',
  'concat(prop("Name"), " · ", prop("Status"))',
];

export type FormulaSuggestionKind = 'function' | 'database' | 'property' | 'context';

export interface FormulaSuggestion {
  kind: FormulaSuggestionKind;
  label: string;
  description?: string;
  insertText: string;
  replaceStart: number;
  replaceEnd: number;
  binding?:
    | { kind: 'database'; databaseId: PageId }
    | { kind: 'property'; databaseId: PageId; propertyId: string };
  caretOffset?: number;
}

export interface FormulaDecoration {
  start: number;
  end: number;
  kind: 'database' | 'property' | 'ambiguous' | 'function' | 'context';
}

export function formulaIdentifier(name: string): string {
  if (
    /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) &&
    !['true', 'false', 'null', 'and', 'or', 'not'].includes(name.toLocaleLowerCase())
  )
    return name;
  return `\`${name.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
}

export function adjustFormulaBindings(
  previous: string,
  next: string,
  bindings: FormulaReferenceBinding[],
): FormulaReferenceBinding[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  )
    suffix++;
  const oldEnd = previous.length - suffix;
  const delta = next.length - suffix - oldEnd;
  return bindings
    .flatMap((binding) => {
      if (binding.end <= prefix) return [binding];
      if (binding.start >= oldEnd)
        return [{ ...binding, start: binding.start + delta, end: binding.end + delta }];
      return [];
    })
    .filter((binding) => next.slice(binding.start, binding.end) === binding.source);
}

function choiceLabel(name: string, id: string, names: Array<{ name: string }>): string {
  return names.filter((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()).length > 1
    ? `${name} · ${id}`
    : name;
}

function decodeIdentifier(source: string): string {
  return source.replace(/\\(.)/g, '$1');
}

function tokenAtCursor(source: string, caret: number): { start: number; end: number; prefix: string } {
  const safeCaret = Math.max(0, Math.min(source.length, caret));
  const before = source.slice(0, safeCaret);
  let inBacktick = false;
  let openBacktick = -1;
  let closedStart = -1;
  let closedEnd = -1;
  for (let index = 0; index < before.length; index++) {
    const char = before[index]!;
    if (char === '\\' && inBacktick && index + 1 < before.length) {
      index++;
      continue;
    }
    if (char !== '`') continue;
    if (inBacktick) {
      inBacktick = false;
      closedStart = openBacktick;
      closedEnd = index + 1;
      openBacktick = -1;
    } else {
      inBacktick = true;
      openBacktick = index;
    }
  }

  if (inBacktick && openBacktick >= 0) {
    const tail = source.slice(safeCaret);
    const closing = tail.indexOf('`');
    return {
      start: openBacktick,
      end: closing < 0 ? safeCaret : safeCaret + closing + 1,
      prefix: decodeIdentifier(source.slice(openBacktick + 1, safeCaret)),
    };
  }
  if (closedEnd === safeCaret && closedStart >= 0) {
    return {
      start: closedStart,
      end: safeCaret,
      prefix: decodeIdentifier(source.slice(closedStart + 1, safeCaret - 1)),
    };
  }

  const prefixMatch = /[\p{L}\p{N}_]*$/u.exec(before)?.[0] ?? '';
  const start = safeCaret - prefixMatch.length;
  const suffixMatch = /^[\p{L}\p{N}_]*/u.exec(source.slice(safeCaret))?.[0] ?? '';
  return { start, end: safeCaret + suffixMatch.length, prefix: prefixMatch };
}

type FormulaSourceKind = 'row' | 'rows' | 'table' | 'scalar';
interface FormulaSource {
  databaseId: PageId | null;
  kind: FormulaSourceKind;
}

function bindingAt(
  bindings: FormulaReferenceBinding[],
  start: number,
  end: number,
): FormulaReferenceBinding | undefined {
  return bindings.find((item) => item.start === start && item.end === end);
}

function databaseForIdentifier(
  name: string,
  span: { start: number; end: number },
  ownerDatabaseId: PageId,
  state: WorkspaceState,
  bindings: FormulaReferenceBinding[],
): FormulaSource {
  const folded = name.trim().toLocaleLowerCase();
  if (folded === 'thisrow' || folded === 'currentvalue')
    return { databaseId: ownerDatabaseId, kind: 'row' };

  const ownerProp = state.pages[ownerDatabaseId]?.database?.properties.find(
    (property) => property.name.trim().toLocaleLowerCase() === folded,
  );
  if (ownerProp?.type === 'relation') {
    const target = relationConfig(ownerProp).targetDatabaseId;
    if (target && state.pages[target]?.database) {
      return { databaseId: target, kind: ownerProp.relation?.multiple ? 'rows' : 'row' };
    }
  }

  const binding = bindingAt(bindings, span.start, span.end);
  if (binding?.kind === 'database')
    return state.pages[binding.databaseId]?.database
      ? { databaseId: binding.databaseId, kind: 'table' }
      : { databaseId: null, kind: 'scalar' };
  const matches = Object.values(state.pages).filter(
    (page) =>
      page.kind === 'database' &&
      page.database &&
      !isEffectivelyTrashed(state.pages, page.id) &&
      displayTitle(page).trim().toLocaleLowerCase() === folded,
  );
  return matches.length === 1
    ? { databaseId: matches[0]!.id, kind: 'table' }
    : { databaseId: null, kind: 'scalar' };
}

function propertyForMember(
  databaseId: PageId,
  name: string,
  span: { start: number; end: number },
  state: WorkspaceState,
  bindings: FormulaReferenceBinding[],
): PropDef | undefined {
  const schema = state.pages[databaseId]?.database;
  if (!schema) return undefined;
  const binding = bindingAt(bindings, span.start, span.end);
  if (binding?.kind === 'property' && binding.databaseId === databaseId)
    return schema.properties.find((property) => property.id === binding.propertyId);
  const matches = schema.properties.filter(
    (property) => property.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function formulaSource(
  expression: Expr,
  ownerDatabaseId: PageId,
  state: WorkspaceState,
  bindings: FormulaReferenceBinding[],
): FormulaSource {
  if (expression.kind === 'identifier')
    return databaseForIdentifier(expression.name, expression, ownerDatabaseId, state, bindings);
  if (expression.kind === 'member') {
    const base = formulaSource(expression.object, ownerDatabaseId, state, bindings);
    if (!base.databaseId) return { databaseId: null, kind: 'scalar' };
    const property = propertyForMember(
      base.databaseId,
      expression.name,
      { start: expression.nameStart, end: expression.nameEnd },
      state,
      bindings,
    );
    if (property?.type !== 'relation') return { databaseId: null, kind: 'scalar' };
    const target = relationConfig(property).targetDatabaseId;
    return target && state.pages[target]?.database
      ? { databaseId: target, kind: property.relation?.multiple ? 'rows' : 'row' }
      : { databaseId: null, kind: 'scalar' };
  }
  if (expression.kind === 'call') {
    if (expression.callee.kind === 'member') {
      const base = formulaSource(expression.callee.object, ownerDatabaseId, state, bindings);
      const method = expression.callee.name.toLocaleLowerCase();
      if (base.databaseId && ['filter', 'formulamap', 'foreach', 'unique'].includes(method))
        return { databaseId: base.databaseId, kind: 'rows' };
      if (base.databaseId && method === 'first')
        return { databaseId: base.databaseId, kind: base.kind === 'table' || base.kind === 'rows' ? 'row' : 'scalar' };
      return { databaseId: null, kind: 'scalar' };
    }
    if (
      expression.callee.kind === 'identifier' &&
      expression.callee.name.toLocaleLowerCase() === 'first' &&
      expression.args[0]
    ) {
      const base = formulaSource(expression.args[0], ownerDatabaseId, state, bindings);
      return base.databaseId && (base.kind === 'table' || base.kind === 'rows')
        ? { databaseId: base.databaseId, kind: 'row' }
        : { databaseId: null, kind: 'scalar' };
    }
  }
  return { databaseId: null, kind: 'scalar' };
}

function trailingExpressionStart(source: string): number {
  let parentheses = 0;
  let brackets = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = source.length - 1; index >= 0; index--) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === ')') parentheses++;
    else if (char === '(') {
      if (parentheses === 0) return index + 1;
      parentheses--;
    } else if (char === ']') brackets++;
    else if (char === '[') {
      if (brackets === 0) return index + 1;
      brackets--;
    } else if (parentheses === 0 && brackets === 0 && /[\s,+*/%=<>!&|^]/u.test(char)) {
      return index + 1;
    }
  }
  return 0;
}

const COLLECTION_METHODS = ['Filter', 'FormulaMap', 'ForEach', 'First', 'Unique'];

export function formulaSuggestions(
  source: string,
  caret: number,
  ownerDatabaseId: PageId,
  database: DatabaseDef,
  state: WorkspaceState,
  bindings: FormulaReferenceBinding[],
): FormulaSuggestion[] {
  const token = tokenAtCursor(source, caret);
  const afterDot = token.start > 0 && source[token.start - 1] === '.';
  if (!token.prefix && !afterDot) return [];

  const candidates: FormulaSuggestion[] = [];
  if (afterDot) {
    const dot = token.start - 1;
    const beforeDot = source.slice(0, dot).trimEnd();
    const receiverStart = trailingExpressionStart(beforeDot);
    const receiverText = beforeDot.slice(receiverStart);
    try {
      const receiverExpr = parseFormula(receiverText);
      const receiver = formulaSource(receiverExpr, ownerDatabaseId, state, bindings);
      const target = receiver.databaseId ? state.pages[receiver.databaseId]?.database : undefined;
      if (target) {
        for (const property of target.properties) {
          if (property.name.toLocaleLowerCase().startsWith(token.prefix.toLocaleLowerCase()))
            candidates.push({
              kind: 'property',
              label: property.name,
              description: property.description,
              insertText: formulaIdentifier(property.name),
              replaceStart: token.start,
              replaceEnd: token.end,
              binding: { kind: 'property', databaseId: receiver.databaseId!, propertyId: property.id },
            });
        }
        if (receiver.kind === 'rows' || receiver.kind === 'table') {
          for (const method of COLLECTION_METHODS) {
            if (method.toLocaleLowerCase().startsWith(token.prefix.toLocaleLowerCase()))
              candidates.push({
                kind: 'function',
                label: `${method}()`,
                description: undefined,
                insertText: `${method}()`,
                replaceStart: token.start,
                replaceEnd: token.end,
                caretOffset: method.length + 1,
              });
          }
        }
      }
    } catch {
      return [];
    }
    return candidates.slice(0, 20);
  }

  const allTables = Object.values(state.pages)
    .filter(
      (page) => page.kind === 'database' && page.database && !isEffectivelyTrashed(state.pages, page.id),
    )
    .sort((left, right) => displayTitle(left).localeCompare(displayTitle(right)));
  const fieldNames = database.properties.map((property) => ({ name: property.name }));
  const tableNames = allTables.map((table) => ({ name: displayTitle(table) }));
  const foldedPrefix = token.prefix.toLocaleLowerCase();

  if ('thisrow'.startsWith(foldedPrefix))
    candidates.push({
      kind: 'context',
      label: 'thisRow',
      insertText: 'thisRow.',
      replaceStart: token.start,
      replaceEnd: token.end,
      caretOffset: 'thisRow.'.length,
    });
  for (const name of FORMULA_FUNCTIONS.split(', ')) {
    if (name.toLocaleLowerCase().startsWith(foldedPrefix))
      candidates.push({
        kind: 'function',
        label: `${name}()`,
        insertText: `${name}()`,
        replaceStart: token.start,
        replaceEnd: token.end,
        caretOffset: name.length + 1,
      });
  }
  for (const table of allTables) {
    const name = displayTitle(table);
    if (name.toLocaleLowerCase().startsWith(foldedPrefix))
      candidates.push({
        kind: 'database',
        label: choiceLabel(name, table.id, tableNames),
        insertText: formulaIdentifier(name),
        replaceStart: token.start,
        replaceEnd: token.end,
        binding: { kind: 'database', databaseId: table.id },
      });
  }
  for (const property of database.properties) {
    if (property.name.toLocaleLowerCase().startsWith(foldedPrefix))
      candidates.push({
        kind: 'property',
        label: choiceLabel(property.name, property.id, fieldNames),
        description: property.description,
        insertText: formulaIdentifier(property.name),
        replaceStart: token.start,
        replaceEnd: token.end,
        binding: { kind: 'property', databaseId: ownerDatabaseId, propertyId: property.id },
      });
  }
  return candidates.slice(0, 8);
}

function addFunctionDecorations(expression: Expr, decorations: FormulaDecoration[], known: Set<string>) {
  if (expression.kind === 'call') {
    if (expression.callee.kind === 'identifier' && known.has(expression.callee.name.toLocaleLowerCase()))
      decorations.push({ start: expression.callee.start, end: expression.callee.end, kind: 'function' });
    else if (expression.callee.kind === 'member' && known.has(expression.callee.name.toLocaleLowerCase()))
      decorations.push({ start: expression.callee.nameStart, end: expression.callee.nameEnd, kind: 'function' });
    addFunctionDecorations(expression.callee, decorations, known);
    for (const argument of expression.args) addFunctionDecorations(argument, decorations, known);
  } else if (expression.kind === 'member') addFunctionDecorations(expression.object, decorations, known);
  else if (expression.kind === 'list')
    for (const item of expression.items) addFunctionDecorations(item, decorations, known);
  else if (expression.kind === 'unary') addFunctionDecorations(expression.arg, decorations, known);
  else if (expression.kind === 'binary') {
    addFunctionDecorations(expression.left, decorations, known);
    addFunctionDecorations(expression.right, decorations, known);
  }
}

export function formulaDecorations(
  source: string,
  bindings: FormulaReferenceBinding[],
): FormulaDecoration[] {
  const decorations: FormulaDecoration[] = bindings
    .filter((binding) => binding.start >= 0 && binding.end <= source.length && binding.end > binding.start)
    .map((binding) => ({
      start: binding.start,
      end: binding.end,
      kind:
        binding.kind === 'database' || binding.kind === 'property' || binding.kind === 'ambiguous'
          ? binding.kind
          : 'ambiguous',
    }));
  const knownFunctions = new Set([...FORMULA_FUNCTIONS.split(', '), 'prop'].map((name) => name.toLocaleLowerCase()));
  try {
    const root = parseFormula(source);
    addFunctionDecorations(root, decorations, knownFunctions);
  } catch {
    // A partially typed expression still keeps its valid, already-bound spans highlighted.
  }
  try {
    const root = parseFormula(source);
    const addContextIdentifiers = (expression: Expr) => {
      if (
        expression.kind === 'identifier' &&
        ['thisrow', 'currentvalue'].includes(expression.name.toLocaleLowerCase())
      ) decorations.push({ start: expression.start, end: expression.end, kind: 'context' });
      else if (expression.kind === 'member') addContextIdentifiers(expression.object);
      else if (expression.kind === 'call') {
        addContextIdentifiers(expression.callee);
        expression.args.forEach(addContextIdentifiers);
      } else if (expression.kind === 'list') expression.items.forEach(addContextIdentifiers);
      else if (expression.kind === 'unary') addContextIdentifiers(expression.arg);
      else if (expression.kind === 'binary') {
        addContextIdentifiers(expression.left);
        addContextIdentifiers(expression.right);
      }
    };
    addContextIdentifiers(root);
  } catch {
    // Keep useful bindings visible while the rest of the expression is incomplete.
  }
  const priority: Record<FormulaDecoration['kind'], number> = {
    ambiguous: 5,
    property: 4,
    database: 3,
    function: 2,
    context: 1,
  };
  const unique = new Map<string, FormulaDecoration>();
  for (const decoration of decorations) {
    const key = `${decoration.start}:${decoration.end}`;
    const current = unique.get(key);
    if (!current || priority[decoration.kind] > priority[current.kind]) unique.set(key, decoration);
  }
  return [...unique.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}
