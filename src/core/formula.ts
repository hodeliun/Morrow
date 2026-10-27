import { isValidDateKey, isValidDateTime } from './typedValues';

// A bounded, pure expression language for database formulas. It deliberately has no eval, I/O,
// mutation, or access to the host environment.
export type FormulaValue = number | string | boolean | null;

export interface FormulaRowRef {
  readonly formulaKind: 'row';
  readonly id: string;
  readonly databaseId: string;
}

export interface FormulaTableRef {
  readonly formulaKind: 'table';
  readonly databaseId: string;
}

export interface FormulaRowList {
  readonly formulaKind: 'rows';
  readonly databaseId: string;
  readonly rows: FormulaRowRef[];
}

export type FormulaRuntimeValue = FormulaValue | FormulaRuntimeValue[] | FormulaRowRef | FormulaTableRef | FormulaRowList;

export interface FormulaSpan {
  start: number;
  end: number;
}

export type Expr =
  | { kind: 'literal'; value: FormulaValue; start: number; end: number }
  | { kind: 'identifier'; name: string; start: number; end: number }
  | { kind: 'call'; callee: Expr; args: Expr[]; start: number; end: number }
  | { kind: 'member'; object: Expr; name: string; start: number; end: number; nameStart: number; nameEnd: number }
  | { kind: 'list'; items: Expr[]; start: number; end: number }
  | { kind: 'unary'; op: string; arg: Expr; start: number; end: number }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; start: number; end: number };

type Token = { kind: 'number' | 'string' | 'name' | 'op'; value: string; start: number; end: number };

const MAX_LENGTH = 2000;
const MAX_DEPTH = 64;
const MAX_STEPS = 10_000;
const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '^', '<', '>', '=', '!', '(', ')', ',', '.', '[', ']'];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (/\s/u.test(char)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(source.slice(i));
      if (!match) throw new Error(`Unexpected “${char}”`);
      tokens.push({ kind: 'number', value: match[0], start: i, end: i + match[0].length });
      i += match[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== char; j++) {
        if (source[j] === '\\' && j + 1 < source.length) {
          j++;
          const escaped = source[j]!;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
        } else value += source[j];
      }
      if (j >= source.length) throw new Error('A piece of text is missing its closing quote');
      tokens.push({ kind: 'string', value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (char === '`') {
      let value = '';
      let j = i + 1;
      for (; j < source.length && source[j] !== '`'; j++) {
        if (source[j] === '\\' && j + 1 < source.length) value += source[++j];
        else value += source[j];
      }
      if (j >= source.length) throw new Error('A name is missing its closing backtick');
      if (!value) throw new Error('A name cannot be empty');
      tokens.push({ kind: 'name', value, start: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    const name = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(source.slice(i));
    if (name) {
      tokens.push({ kind: 'name', value: name[0], start: i, end: i + name[0].length });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new Error(`Unexpected “${char}”`);
    tokens.push({ kind: 'op', value: op, start: i, end: i + op.length });
    i += op.length;
  }
  return tokens;
}

const PRECEDENCE: Record<string, number> = {
  or: 1, '||': 1, and: 2, '&&': 2,
  '==': 3, '=': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '^': 7,
};

export function parseFormula(source: string): Expr {
  if (source.length > MAX_LENGTH) throw new Error('This formula is too long');
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isOp = (value: string) => {
    const token = peek();
    return token?.kind === 'op' && token.value === value;
  };
  const isName = (value: string) => peek()?.kind === 'name' && peek()!.value.toLowerCase() === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`Expected “${value}”`);
    return take()!;
  };
  const expression = (minPrecedence = 0, depth = 0): Expr => {
    if (depth > MAX_DEPTH) throw new Error('This formula is nested too deeply');
    let left = unary(depth + 1);
    for (;;) {
      const token = peek();
      const key = token?.kind === 'op' ? token.value : token?.kind === 'name' ? token.value.toLowerCase() : '';
      const precedence = PRECEDENCE[key];
      if (precedence === undefined || precedence < minPrecedence) break;
      take();
      const op = key === 'or' ? '||' : key === 'and' ? '&&' : key === '=' ? '==' : key;
      const right = expression(precedence + (op === '^' ? 0 : 1), depth + 1);
      left = { kind: 'binary', op, left, right, start: left.start, end: right.end };
    }
    return left;
  };
  const unary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new Error('This formula is nested too deeply');
    const token = peek();
    if (token?.kind === 'op' && (token.value === '-' || token.value === '!')) {
      take();
      const arg = unary(depth + 1);
      return { kind: 'unary', op: token.value, arg, start: token.start, end: arg.end };
    }
    if (isName('not')) {
      const start = take()!.start;
      const arg = unary(depth + 1);
      return { kind: 'unary', op: '!', arg, start, end: arg.end };
    }
    return postfix(primary(depth + 1), depth + 1);
  };
  const primary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new Error('This formula is nested too deeply');
    const token = take();
    if (!token) throw new Error('The formula ends too early');
    if (token.kind === 'number') return { kind: 'literal', value: Number(token.value), start: token.start, end: token.end };
    if (token.kind === 'string') return { kind: 'literal', value: token.value, start: token.start, end: token.end };
    if (token.kind === 'op' && token.value === '(') {
      const inner = expression(0, depth + 1);
      const end = expect(')').end;
      return { ...inner, start: token.start, end };
    }
    if (token.kind === 'op' && token.value === '[') {
      const items: Expr[] = [];
      if (!isOp(']')) {
        while (!isOp(']')) {
          items.push(expression(0, depth + 1));
          if (!isOp(',')) break;
          take();
        }
      }
      const end = expect(']').end;
      return { kind: 'list', items, start: token.start, end };
    }
    if (token.kind === 'name') {
      const lower = token.value.toLowerCase();
      if (lower === 'true' || lower === 'false')
        return { kind: 'literal', value: lower === 'true', start: token.start, end: token.end };
      if (lower === 'null' || lower === 'blank')
        return { kind: 'literal', value: null, start: token.start, end: token.end };
      return { kind: 'identifier', name: token.value, start: token.start, end: token.end };
    }
    throw new Error(`Unexpected “${token.value}”`);
  };
  const postfix = (initial: Expr, depth: number): Expr => {
    let current = initial;
    for (;;) {
      if (isOp('.')) {
        take();
        const name = take();
        if (!name || name.kind !== 'name') throw new Error('Expected a field or function name after “.”');
        current = {
          kind: 'member', object: current, name: name.value,
          start: current.start, end: name.end, nameStart: name.start, nameEnd: name.end,
        };
        continue;
      }
      if (isOp('(')) {
        take();
        const args: Expr[] = [];
        while (!isOp(')')) {
          args.push(expression(0, depth + 1));
          if (!isOp(',')) break;
          take();
        }
        const end = expect(')').end;
        current = { kind: 'call', callee: current, args, start: current.start, end };
        continue;
      }
      if (isOp('[')) {
        take();
        const key = expression(0, depth + 1);
        const end = expect(']').end;
        current = { kind: 'call', callee: { kind: 'identifier', name: '__index', start: current.start, end: current.end }, args: [current, key], start: current.start, end };
        continue;
      }
      break;
    }
    return current;
  };
  const root = expression();
  if (pos < tokens.length) throw new Error(`Unexpected “${tokens[pos]!.value}”`);
  return root;
}

export interface FormulaEvaluationContext {
  resolveIdentifier?: (name: string, span: FormulaSpan) => FormulaRuntimeValue;
  resolveMember?: (receiver: FormulaRuntimeValue, name: string, span: FormulaSpan, receiverExpression?: Expr) => FormulaRuntimeValue;
  invokeMethod?: (
    receiver: FormulaRuntimeValue,
    name: string,
    arguments_: Expr[],
    evaluate: (expr: Expr, currentValue?: FormulaRuntimeValue) => FormulaRuntimeValue,
    span: FormulaSpan,
  ) => FormulaRuntimeValue;
}

const toNumber = (value: FormulaRuntimeValue): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  throw new Error(`Expected a number, received ${describeType(value)}`);
};
const toText = (value: FormulaRuntimeValue): string =>
  value === null ? '' : typeof value === 'number' ? String(Math.round(value * 1e10) / 1e10) : typeof value === 'string' || typeof value === 'boolean' ? String(value) : Array.isArray(value) ? value.map(toText).join(', ') : value.formulaKind === 'row' ? value.id : value.databaseId;
const truthy = (value: FormulaRuntimeValue): boolean =>
  value !== null && value !== false && value !== 0 && value !== '';
const describeType = (value: FormulaRuntimeValue): string =>
  value === null ? 'blank' : Array.isArray(value) ? 'a list' : typeof value === 'object' ? value.formulaKind === 'row' ? 'a row' : value.formulaKind === 'rows' ? 'a list of rows' : 'a table' : typeof value;
const equal = (a: FormulaRuntimeValue, b: FormulaRuntimeValue): boolean => {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    if (a.formulaKind !== b.formulaKind) return false;
    return a.formulaKind === 'row' ? a.id === (b as FormulaRowRef).id && a.databaseId === b.databaseId : a.databaseId === b.databaseId;
  }
  return false;
};

function scalarFunctions(name: string, args: FormulaRuntimeValue[], now: Date): FormulaRuntimeValue | undefined {
  const arg = (index: number, fallback: FormulaRuntimeValue = null) => args[index] ?? fallback;
  const list = (value: FormulaRuntimeValue): FormulaRuntimeValue[] => Array.isArray(value) ? value : typeof value === 'object' && value !== null && !Array.isArray(value) && value.formulaKind === 'rows' ? value.rows : [value];
  const count = (expected: number, min = expected) => {
    if (args.length < min || args.length > expected) throw new Error(`${name}() expects ${min === expected ? expected : `between ${min} and ${expected}`} arguments`);
  };
  switch (name.toLowerCase()) {
    case 'if': count(3, 2); return truthy(arg(0)) ? arg(1) : arg(2);
    case 'switch': {
      if (args.length < 3) throw new Error('Switch() expects a value, at least one case and a result');
      const value = arg(0);
      for (let i = 1; i + 1 < args.length; i += 2) if (equal(value, args[i]!)) return args[i + 1]!;
      return args.length % 2 === 0 ? args[args.length - 1]! : null;
    }
    case 'withname': count(3); return undefined; // evaluated lazily by the interpreter
    case 'contains': count(2); return Array.isArray(arg(0)) ? list(arg(0)).some((item) => equal(item, arg(1))) : toText(arg(0)).toLocaleLowerCase().includes(toText(arg(1)).toLocaleLowerCase());
    case 'unique': count(1); return list(arg(0)).filter((item, index, all) => all.findIndex((candidate) => equal(candidate, item)) === index);
    case 'list': return args;
    case 'sequence': {
      count(3, 1);
      const start = args.length === 1 ? 1 : toNumber(arg(0));
      const end = args.length === 1 ? toNumber(arg(0)) : toNumber(arg(1));
      const step = args.length < 3 ? 1 : toNumber(arg(2));
      if (step === 0) throw new Error('Sequence() step cannot be zero');
      const result: FormulaRuntimeValue[] = [];
      for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
        if (result.length >= 2000) throw new Error('Sequence() is limited to 2000 values');
        result.push(value);
      }
      return result;
    }
    case 'formulamap':
    case 'foreach': return undefined; // evaluated lazily with CurrentValue scope
    case 'first': count(1); return list(arg(0))[0] ?? null;
    case 'isblank':
    case 'empty': count(1); { const value = arg(0); return value === null || value === '' || (Array.isArray(value) && value.length === 0) || (typeof value === 'object' && value !== null && !Array.isArray(value) && value.formulaKind === 'rows' && value.rows.length === 0); }
    case 'tonumber':
    case 'number': count(1); return toNumber(arg(0));
    case 'totext':
    case 'text':
    case 'format': count(1); return toText(arg(0));
      case 'round': count(2, 1); { const places = Math.max(0, Math.min(10, Math.trunc(toNumber(arg(1, 0))))); return decimalRound(toNumber(arg(0)), places); }
    case 'floor': count(1); return Math.floor(toNumber(arg(0)));
    case 'ceil': count(1); return Math.ceil(toNumber(arg(0)));
    case 'mod':
    case 'modulo': count(2); { const divisor = toNumber(arg(1)); if (divisor === 0) throw new Error('Modulo by zero is not allowed'); return toNumber(arg(0)) % divisor; }
    case 'abs': count(1); return Math.abs(toNumber(arg(0)));
    case 'sqrt': count(1); { const result = Math.sqrt(toNumber(arg(0))); if (!Number.isFinite(result)) throw new Error('Square root requires a non-negative number'); return result; }
    case 'min':
    case 'max':
    case 'sum': {
      const values = args.flatMap((value) => list(value)).map(toNumber);
      if (!values.length) return name.toLowerCase() === 'sum' ? 0 : null;
      return name.toLowerCase() === 'min' ? Math.min(...values) : name.toLowerCase() === 'max' ? Math.max(...values) : values.reduce((total, value) => total + value, 0);
    }
    case 'average':
    case 'avg': { const values = args.flatMap((value) => list(value)).map(toNumber); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
    case 'count': count(1); return list(arg(0)).filter((value) => value !== null).length;
    case 'length': count(1); { const value = arg(0); return Array.isArray(value) ? value.length : typeof value === 'object' && value !== null && value.formulaKind === 'rows' ? value.rows.length : [...toText(value)].length; }
    case 'concat': return args.map(toText).join('');
    case 'join': count(2, 1); { const [separator = ',', ...values] = args; const items = values.length === 1 && Array.isArray(values[0]) ? values[0] : values; return items.map(toText).join(toText(separator)); }
    case 'upper': count(1); return toText(arg(0)).toLocaleUpperCase();
    case 'lower': count(1); return toText(arg(0)).toLocaleLowerCase();
    case 'replace': count(3); return toText(arg(0)).split(toText(arg(1))).join(toText(arg(2)));
    case 'slice': count(3, 2); return toText(arg(0)).slice(toNumber(arg(1)), args.length > 2 ? toNumber(arg(2)) : undefined);
    case 'now': count(0); return now.getTime();
    case 'today': count(0); return dateText(now);
    case 'dateadd': {
      count(3);
      const dateValue = arg(0);
      const start = toDate(dateValue);
      if (!start) throw new Error('DateAdd() needs a valid date');
      const amount = toNumber(arg(1));
      const unit = toText(arg(2)).toLowerCase();
      const result = new Date(start);
      const dateOnly = typeof dateValue === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateValue);
      if (unit.startsWith('month')) addMonthsClamped(result, amount);
      else if (unit.startsWith('year')) addMonthsClamped(result, amount * 12);
      else if (dateOnly && (unit.startsWith('day') || unit.startsWith('week')))
        result.setDate(result.getDate() + amount * (unit.startsWith('week') ? 7 : 1));
      else result.setTime(result.getTime() + amount * (UNITS[unit] ?? DAY));
      return dateOnly ? dateText(result) : result.toISOString();
    }
    case 'datebetween': { count(3); const first = toDate(arg(0)); const second = toDate(arg(1)); if (!first || !second) throw new Error('DateBetween() needs two dates'); return Math.trunc((first.getTime() - second.getTime()) / (UNITS[toText(arg(2)).toLowerCase()] ?? DAY)); }
    case 'year': count(1); { const date = toDate(arg(0)); if (!date) throw new Error('Year() needs a date'); return date.getFullYear(); }
    case 'month': count(1); { const date = toDate(arg(0)); if (!date) throw new Error('Month() needs a date'); return date.getMonth() + 1; }
    case 'day': count(1); { const date = toDate(arg(0)); if (!date) throw new Error('Day() needs a date'); return date.getDate(); }
    default: return undefined;
  }
}

interface Scope { currentValue?: FormulaRuntimeValue; locals: Map<string, FormulaRuntimeValue>; }

export function evaluateRuntimeFormula(
  expr: Expr,
  context: FormulaEvaluationContext = {},
  now = new Date(),
): FormulaRuntimeValue {
  let steps = 0;
  const run = (node: Expr, scope: Scope = { locals: new Map() }): FormulaRuntimeValue => {
    if (++steps > MAX_STEPS) throw new Error('This formula takes too long');
    switch (node.kind) {
      case 'literal': return node.value;
      case 'identifier': {
        if (scope.locals.has(node.name.toLowerCase())) return scope.locals.get(node.name.toLowerCase())!;
        if (node.name.toLowerCase() === 'currentvalue' && scope.currentValue !== undefined) return scope.currentValue;
        if (!context.resolveIdentifier) throw new Error(`There is no value or table called “${node.name}”`);
        return context.resolveIdentifier(node.name, node);
      }
      case 'list': return node.items.map((item) => run(item, scope));
      case 'member': {
        const receiver = run(node.object, scope);
        if (!context.resolveMember) throw new Error(`Cannot read “${node.name}” from ${describeType(receiver)}`);
        return context.resolveMember(receiver, node.name, { start: node.nameStart, end: node.nameEnd }, node.object);
      }
      case 'unary': {
        const value = run(node.arg, scope);
        if (node.op === '!') return !truthy(value);
        return -toNumber(value);
      }
      case 'binary': {
        if (node.op === '&&') return truthy(run(node.left, scope)) && truthy(run(node.right, scope));
        if (node.op === '||') return truthy(run(node.left, scope)) || truthy(run(node.right, scope));
        const left = run(node.left, scope);
        const right = run(node.right, scope);
        switch (node.op) {
          case '+': return typeof left === 'string' || typeof right === 'string' ? toText(left) + toText(right) : toNumber(left) + toNumber(right);
          case '-': return toNumber(left) - toNumber(right);
          case '*': return toNumber(left) * toNumber(right);
          case '/': { const divisor = toNumber(right); if (divisor === 0) throw new Error('Division by zero is not allowed'); return toNumber(left) / divisor; }
          case '%': { const divisor = toNumber(right); if (divisor === 0) throw new Error('Modulo by zero is not allowed'); return toNumber(left) % divisor; }
          case '^': return toNumber(left) ** toNumber(right);
          case '==': return equal(left, right);
          case '!=': return !equal(left, right);
          default: {
            const order = typeof left === 'number' && typeof right === 'number' ? left - right : toText(left).localeCompare(toText(right));
            return node.op === '<' ? order < 0 : node.op === '<=' ? order <= 0 : node.op === '>' ? order > 0 : order >= 0;
          }
        }
      }
      case 'call': {
        if (node.callee.kind === 'member') {
          const receiver = run(node.callee.object, scope);
          if (!context.invokeMethod) throw new Error(`Unknown function ${node.callee.name}()`);
          return context.invokeMethod(receiver, node.callee.name, node.args, (arg, currentValue) =>
            run(arg, currentValue === undefined ? scope : { ...scope, currentValue }), node.callee);
        }
        if (node.callee.kind !== 'identifier') throw new Error('Only named functions can be called');
        const name = node.callee.name.toLowerCase();
        if (name === '__index') {
          if (node.args.length !== 2) throw new Error('A list or row access needs one index or field name');
          const receiver = run(node.args[0]!, scope);
          const key = run(node.args[1]!, scope);
          if (Array.isArray(receiver)) {
            const index = Math.trunc(toNumber(key));
            return receiver[index < 0 ? receiver.length + index : index] ?? null;
          }
          if (typeof receiver === 'object' && receiver !== null && receiver.formulaKind === 'rows') {
            const index = Math.trunc(toNumber(key));
            return receiver.rows[index < 0 ? receiver.rows.length + index : index] ?? null;
          }
          if (typeof key === 'string' && receiver !== null && typeof receiver === 'object' && !Array.isArray(receiver)) {
            if (!context.resolveMember) throw new Error(`Cannot read “${key}” from ${describeType(receiver)}`);
            return context.resolveMember(receiver, key, node.args[1]!);
          }
          throw new Error('Use a number to access a list item or a text name to access a row field');
        }
        if (name === 'prop') {
          if (node.args.length !== 1) throw new Error('prop() expects one property name');
          const property = toText(run(node.args[0]!, scope));
          if (!context.resolveIdentifier) throw new Error('prop() is only available in a database formula');
          return context.resolveIdentifier(property, node.args[0]!);
        }
        if (name === 'withname') {
          if (node.args.length !== 3) throw new Error('WithName() expects a value, a name and an expression');
          const value = run(node.args[0]!, scope);
          const aliasExpression = node.args[1]!;
          const alias = (aliasExpression.kind === 'identifier' ? aliasExpression.name : toText(run(aliasExpression, scope))).toLowerCase();
          if (!alias) throw new Error('WithName() needs a non-empty name');
          const locals = new Map(scope.locals);
          locals.set(alias, value);
          return run(node.args[2]!, { ...scope, locals });
        }
        if (name === 'iferror') {
          if (node.args.length !== 2) throw new Error('IfError() expects two arguments');
          try {
            const value = run(node.args[0]!, scope);
            if (typeof value === 'number' && !Number.isFinite(value))
              throw new Error('This formula produced a number outside the supported range');
            return value;
          } catch {
            return run(node.args[1]!, scope);
          }
        }
        if (name === 'if') {
          if (node.args.length < 2 || node.args.length > 3) throw new Error('If() expects two or three arguments');
          return truthy(run(node.args[0]!, scope)) ? run(node.args[1]!, scope) : node.args[2] ? run(node.args[2], scope) : null;
        }
        if (name === 'switch') {
          if (node.args.length < 3) throw new Error('Switch() expects a value, at least one case and a result');
          const value = run(node.args[0]!, scope);
          for (let i = 1; i + 1 < node.args.length; i += 2)
            if (equal(value, run(node.args[i]!, scope))) return run(node.args[i + 1]!, scope);
          return node.args.length % 2 === 0 ? run(node.args[node.args.length - 1]!, scope) : null;
        }
        if (name === 'formulamap' || name === 'foreach') {
          if (node.args.length !== 2) throw new Error(`${node.callee.name}() expects a list and an expression`);
          const source = run(node.args[0]!, scope);
          const values = Array.isArray(source) ? source : typeof source === 'object' && source !== null && source.formulaKind === 'rows' ? source.rows : null;
          if (!values) throw new Error(`${node.callee.name}() expects a list`);
          if (values.length > 2000) throw new Error(`${node.callee.name}() is limited to 2000 values`);
          return values.map((value) => run(node.args[1]!, { ...scope, currentValue: value }));
        }
        const args = node.args.map((arg) => run(arg, scope));
        const result = scalarFunctions(name, args, now);
        if (result !== undefined) return result;
        throw new Error(`There is no function called ${node.callee.name}()`);
      }
    }
  };
  const value = run(expr);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('This formula produced a number outside the supported range');
  return value;
}

// Compatibility API for the original same-row prop("Name") formula language.
export function evaluateFormula(expr: Expr, prop: (name: string) => FormulaValue, now = new Date()): FormulaValue {
  const value = evaluateRuntimeFormula(expr, {
    resolveIdentifier(name) {
      const value = prop(name);
      if (value === null) throw new Error(`Property “${name}” is blank or missing`);
      return value;
    },
  }, now);
  if (Array.isArray(value) || (typeof value === 'object' && value !== null))
    throw new Error('This formula returned a list or row where a single value is required');
  return value;
}

const cache = new Map<string, Expr | Error>();
function parsedFormula(source: string): Expr | Error {
  let parsed = cache.get(source);
  if (!parsed) {
    try { parsed = parseFormula(source); }
    catch (error) { parsed = error instanceof Error ? error : new Error(String(error)); }
    if (cache.size > 500) cache.clear();
    cache.set(source, parsed);
  }
  return parsed;
}

export function formulaUsesCurrentTime(source: string): boolean {
  const parsed = parsedFormula(source);
  if (parsed instanceof Error) return false;
  const visit = (expr: Expr): boolean => {
    if (expr.kind === 'call') {
      if (expr.callee.kind === 'identifier' && ['now', 'today'].includes(expr.callee.name.toLowerCase())) return true;
      return visit(expr.callee) || expr.args.some(visit);
    }
    if (expr.kind === 'member') return visit(expr.object);
    if (expr.kind === 'list') return expr.items.some(visit);
    if (expr.kind === 'unary') return visit(expr.arg);
    if (expr.kind === 'binary') return visit(expr.left) || visit(expr.right);
    return false;
  };
  return visit(parsed);
}

export function computeRuntimeFormula(
  source: string,
  context: FormulaEvaluationContext,
  now = new Date(),
): { value: FormulaRuntimeValue; error: string | null } {
  if (!source.trim()) return { value: null, error: null };
  const parsed = parsedFormula(source);
  if (parsed instanceof Error) return { value: null, error: parsed.message };
  try { return { value: evaluateRuntimeFormula(parsed, context, now), error: null }; }
  catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
}

export function computeFormula(
  source: string,
  prop: (name: string) => FormulaValue,
  now = new Date(),
): { value: FormulaValue; error: string | null } {
  if (!source.trim()) return { value: null, error: null };
  const parsed = parsedFormula(source);
  if (parsed instanceof Error) return { value: null, error: parsed.message };
  try { return { value: evaluateFormula(parsed, prop, now), error: null }; }
  catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
}

const DAY = 86_400_000;
const UNITS: Record<string, number> = { days: DAY, day: DAY, weeks: 7 * DAY, week: 7 * DAY, hours: 3_600_000, hour: 3_600_000 };
function toDate(value: FormulaRuntimeValue): Date | null {
  if (typeof value === 'number') { const date = new Date(value); return Number.isFinite(date.getTime()) ? date : null; }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    if (!isValidDateTime(value)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDateKey(`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)) return null;
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return Number.isFinite(date.getTime()) ? date : null;
}
function dateText(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function decimalRound(value: number, places: number): number {
  const sign = Math.sign(value) || 1;
  const shifted = Number(`${Math.abs(value)}e${places}`);
  return sign * Math.round(shifted) / 10 ** places;
}

function addMonthsClamped(date: Date, months: number): void {
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
}
