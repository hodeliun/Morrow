export interface MarkdownDestinationScan {
  start: number;
  end: number;
  close: number;
}

const MAX_NESTED_PARENS = 32;

/**
 * Finds a Markdown link destination and its closing parenthesis from the opening `(`.
 * `budget` bounds all scanning so malformed input cannot make source recovery unbounded.
 */
export function scanMarkdownDestination(
  text: string,
  openingParenOffset: number,
  budget: number,
): MarkdownDestinationScan | null {
  if (
    !Number.isInteger(openingParenOffset) ||
    openingParenOffset < 0 ||
    text[openingParenOffset] !== '(' ||
    !Number.isFinite(budget) ||
    budget < 1
  )
    return null;

  const limit = Math.min(text.length, openingParenOffset + Math.floor(budget));
  let cursor = openingParenOffset + 1;
  while (cursor < limit && isSpace(text[cursor]!)) cursor++;

  let start: number;
  let end: number;
  if (text[cursor] === '<') {
    start = ++cursor;
    while (cursor < limit) {
      const char = text[cursor]!;
      if (char === '\\') {
        if (cursor + 1 >= limit) return null;
        cursor += 2;
      } else if (char === '>') {
        end = cursor++;
        if (end === start) return null;
        return closingParen(text, start, end, cursor, limit);
      } else if (char === '<' || char === '\n' || char === '\r') return null;
      else cursor++;
    }
    return null;
  }

  start = cursor;
  let nested = 0;
  while (cursor < limit) {
    const char = text[cursor]!;
    if (char === '\\') {
      if (cursor + 1 >= limit) return null;
      if (isBareDestinationBoundary(text[cursor + 1]!)) return null;
      cursor += 2;
      continue;
    }
    if (isBareDestinationBoundary(char)) break;
    if (char === '(' && ++nested > MAX_NESTED_PARENS) return null;
    if (char === ')') {
      if (nested === 0) break;
      nested--;
    }
    cursor++;
  }
  if (nested !== 0 || cursor === start) return null;
  end = cursor;
  return closingParen(text, start, end, cursor, limit);
}

function closingParen(
  text: string,
  start: number,
  end: number,
  cursor: number,
  limit: number,
): MarkdownDestinationScan | null {
  let separated = false;
  while (cursor < limit && isSpace(text[cursor]!)) {
    separated = true;
    cursor++;
  }
  if (text[cursor] === ')') return { start, end, close: cursor };
  if (!separated) return null;

  const titleEnd = scanTitle(text, cursor, limit);
  if (titleEnd === null) return null;
  cursor = titleEnd;
  while (cursor < limit && isSpace(text[cursor]!)) cursor++;
  return text[cursor] === ')' ? { start, end, close: cursor } : null;
}

function scanTitle(text: string, start: number, limit: number): number | null {
  const opening = text[start];
  if (opening !== '"' && opening !== "'" && opening !== '(') return null;
  const closing = opening === '(' ? ')' : opening;
  let depth = opening === '(' ? 1 : 0;
  for (let cursor = start + 1; cursor < limit; cursor++) {
    const char = text[cursor]!;
    if (char === '\\') {
      if (cursor + 1 >= limit) return null;
      cursor++;
    } else if (opening === '(' && char === '(') {
      if (++depth > MAX_NESTED_PARENS) return null;
    } else if (char === closing) {
      if (opening !== '(' || --depth === 0) return cursor + 1;
    } else if (char === '\n' || char === '\r') return null;
  }
  return null;
}

function isSpace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isBareDestinationBoundary(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x20 || code === 0x7f;
}
