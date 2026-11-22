import type { StateInline } from 'markdown-it';

export const LEGACY_FORMULA_NODE = 'legacyFormula';
const MAX_MARKER_LENGTH = 100_000;
const MARKS_ON_FORMULA = new Set(['bold', 'italic', 'strike', 'underline', 'highlight', 'textColor']);
const LEGACY_OUTPUT_TYPES = new Set(['auto', 'text', 'number', 'currency', 'percent', 'scale', 'progress', 'date', 'checkbox']);

export interface LegacyFormulaMarker {
  readonly raw: string;
  readonly fallback: string;
  readonly resultId: string;
}

/** The only legacy formula data the read-only inline renderer is allowed to receive. */
export interface LegacyFormulaPresentation {
  readonly formula: string;
  readonly outputType: string;
  /** Unknown or unsupported format keys are represented as null, never forwarded. */
  readonly format: Readonly<LegacyFormulaDisplayFormat> | null;
  readonly fallback: string;
}

export interface LegacyFormulaDisplayFormat {
  readonly locale?: string;
  readonly currency?: string;
  readonly precision?: number;
  readonly negativeFormat?: 'minus' | 'parentheses';
  readonly dateStyle?: 'full' | 'long' | 'medium' | 'short';
}

interface OpenTag {
  readonly end: number;
  readonly encodedPayload: string;
}

/** Reads one inert legacy result span without decoding or rewriting its stored markup. */
export function parseLegacyFormulaMarker(source: string, start = 0): LegacyFormulaMarker | null {
  if (start < 0 || start >= source.length) return null;
  const opening = parseLegacyFormulaOpeningTag(source, start);
  if (!opening || opening.end - start > MAX_MARKER_LENGTH) return null;

  const closeStart = source.indexOf('<', opening.end);
  if (closeStart === -1 || closeStart - start > MAX_MARKER_LENGTH) return null;
  const closeOffset = source.slice(closeStart, start + MAX_MARKER_LENGTH + 1).indexOf('>');
  if (closeOffset === -1) return null;
  const closeEnd = closeStart + closeOffset;
  if (closeEnd === -1 || !/^<\/span\s*>$/i.test(source.slice(closeStart, closeEnd + 1))) return null;
  const end = closeEnd + 1;
  if (end - start > MAX_MARKER_LENGTH) return null;
  const raw = source.slice(start, end);
  if (/[\r\n]/.test(raw)) return null;

  const payload = decodePayload(opening.encodedPayload);
  if (!payload) return null;
  return {
    raw,
    fallback: decodeHtmlEntities(source.slice(opening.end, closeStart)),
    resultId: payload.resultId,
  };
}

/** Projects only unbound scalar formula data; identity and source markup never cross the plugin API. */
export function parseLegacyFormulaPresentation(
  raw: string,
  fallback?: string,
): LegacyFormulaPresentation | null {
  const marker = parseLegacyFormulaMarker(raw);
  if (!marker || marker.raw !== raw || (fallback !== undefined && marker.fallback !== fallback)) return null;
  const opening = parseLegacyFormulaOpeningTag(raw);
  if (!opening) return null;
  const payload = decodePayload(opening.encodedPayload);
  if (!payload || payload.bindings.length !== 0 || !LEGACY_OUTPUT_TYPES.has(payload.outputType)) return null;
  return {
    formula: payload.formula,
    outputType: payload.outputType,
    format: projectDisplayFormat(payload.format),
    fallback: marker.fallback,
  };
}

/** Validates a complete opening span while retaining every source attribute as opaque text. */
export function parseLegacyFormulaOpeningTag(source: string, start = 0): OpenTag | null {
  if (
    source.charCodeAt(start) !== 0x3c ||
    source.slice(start, start + 5).toLowerCase() !== '<span' ||
    !/\s/.test(source[start + 5] ?? '')
  ) {
    return null;
  }
  let index = start + 5;
  let encodedPayload: string | null = null;

  while (index < source.length) {
    if (index - start > MAX_MARKER_LENGTH) return null;
    while (index < source.length && index - start <= MAX_MARKER_LENGTH && /\s/.test(source[index]!)) index++;
    if (source[index] === '>') {
      if (encodedPayload === null) return null;
      return { end: index + 1, encodedPayload };
    }
    if (source[index] === '/' || !source[index]) return null;

    const nameStart = index;
    while (
      index < source.length &&
      index - start <= MAX_MARKER_LENGTH &&
      !/[\s=/>]/.test(source[index]!)
    ) {
      index++;
    }
    if (index === nameStart) return null;
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < source.length && index - start <= MAX_MARKER_LENGTH && /\s/.test(source[index]!)) index++;
    if (source[index] !== '=') {
      if (name === 'data-morrow-result') return null;
      continue;
    }
    index++;
    while (index < source.length && index - start <= MAX_MARKER_LENGTH && /\s/.test(source[index]!)) index++;
    const quote = source[index] === '"' || source[index] === "'" ? source[index]! : null;
    let value: string;
    if (quote) {
      const valueStart = ++index;
      while (index < source.length && source[index] !== quote) {
        if (index - start > MAX_MARKER_LENGTH) return null;
        index++;
      }
      if (index >= source.length) return null;
      value = source.slice(valueStart, index);
      index++;
    } else {
      const valueStart = index;
      while (
        index < source.length &&
        index - start <= MAX_MARKER_LENGTH &&
        !/[\s>]/.test(source[index]!)
      ) {
        index++;
      }
      if (index === valueStart) return null;
      value = source.slice(valueStart, index);
    }
    if (name === 'data-morrow-result') {
      if (encodedPayload !== null) return null;
      encodedPayload = value;
    }
  }
  return null;
}

/** Markdown-it inline rule shared by the core reader and the compatibility preflight. */
export function legacyFormulaInlineRule(state: StateInline, silent: boolean): boolean {
  const marker = parseLegacyFormulaMarker(state.src, state.pos);
  if (!marker || state.pos + marker.raw.length > state.posMax) return false;
  state.pos += marker.raw.length;
  if (!silent) {
    const token = state.push(LEGACY_FORMULA_NODE, '', 0);
    token.content = marker.raw;
    token.meta = { raw: marker.raw, fallback: marker.fallback, resultId: marker.resultId };
  }
  return true;
}

/** Validates the narrow model shape and root-paragraph placement needed for safe editing. */
export function legacyFormulaDocIssue(value: unknown): string | null {
  if (!isRecord(value) || value.type !== 'doc' || !Array.isArray(value.content)) return null;
  const resultIds = new Set<string>();
  const stack: Array<{
    node: unknown;
    parentType: string;
    grandparentType: string | null;
    parentNode: Record<string, unknown> | null;
  }> = [];
  for (const node of value.content)
    stack.push({ node, parentType: 'doc', grandparentType: null, parentNode: value });

  while (stack.length) {
    const { node, parentType, grandparentType, parentNode } = stack.pop()!;
    if (!isRecord(node) || typeof node.type !== 'string') continue;
    if (node.type === LEGACY_FORMULA_NODE) {
      if (parentType !== 'paragraph' || grandparentType !== 'doc')
        return 'A legacy formula result is only supported in a top-level paragraph.';
      if (
        Array.isArray(parentNode?.content) &&
        parentNode.content.some(
          (sibling) =>
            isRecord(sibling) &&
            (sibling.type === 'image' ||
              (sibling.type === 'pageLink' && isRecord(sibling.attrs) && sibling.attrs.embed === true) ||
              (Array.isArray(sibling.marks) &&
                sibling.marks.some(
                  (mark) =>
                    isRecord(mark) &&
                    isRecord(mark.attrs) &&
                    isRecord(mark.attrs.fileRef) &&
                    mark.attrs.fileRef.embed === true,
                ))),
        )
      ) {
        return 'A legacy formula result cannot share a paragraph with an embedded media node.';
      }
      const keys = Object.keys(node);
      if (keys.some((key) => !['type', 'attrs', 'marks'].includes(key)))
        return 'A legacy formula result must be an inline atom without content or text.';
      if (
        !isRecord(node.attrs) ||
        Object.keys(node.attrs).length !== 2 ||
        typeof node.attrs.raw !== 'string' ||
        typeof node.attrs.fallback !== 'string'
      ) {
        return 'A legacy formula result has unsupported attributes.';
      }
      if (
        node.marks !== undefined &&
        (!Array.isArray(node.marks) ||
          node.marks.some((mark) => !isRecord(mark) || !MARKS_ON_FORMULA.has(String(mark.type))))
      ) {
        return 'A legacy formula result has an unsupported mark.';
      }
      const marker = parseLegacyFormulaMarker(node.attrs.raw);
      if (!marker || marker.raw.length !== node.attrs.raw.length || marker.fallback !== node.attrs.fallback)
        return 'A legacy formula result does not contain its original marker and fallback.';
      if (resultIds.has(marker.resultId)) return 'A page contains a duplicate legacy formula result ID.';
      resultIds.add(marker.resultId);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content)
        stack.push({ node: child, parentType: node.type, grandparentType: parentType, parentNode: node });
    }
  }
  return null;
}

export function countLegacyFormulaNodes(value: unknown): number {
  if (!isRecord(value)) return 0;
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const node = stack.pop();
    if (!isRecord(node)) continue;
    if (node.type === LEGACY_FORMULA_NODE) count++;
    if (Array.isArray(node.content)) stack.push(...node.content);
  }
  return count;
}

function decodePayload(encoded: string): {
  resultId: string;
  formula: string;
  bindings: unknown[];
  outputType: string;
  format: Record<string, unknown>;
} | null {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!isRecord(parsed)) return null;
    if (
      typeof parsed.resultId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.resultId) ||
      typeof parsed.pageId !== 'string' ||
      typeof parsed.name !== 'string' ||
      parsed.name.length > 100 ||
      typeof parsed.formula !== 'string' ||
      parsed.formula.length > 2000 ||
      !Array.isArray(parsed.bindings) ||
      typeof parsed.outputType !== 'string' ||
      !isRecord(parsed.format)
    ) {
      return null;
    }
    return {
      resultId: parsed.resultId,
      formula: parsed.formula,
      bindings: parsed.bindings,
      outputType: parsed.outputType,
      format: parsed.format,
    };
  } catch {
    return null;
  }
}

function projectDisplayFormat(format: Record<string, unknown>): LegacyFormulaDisplayFormat | null {
  const allowedKeys = new Set(['locale', 'currency', 'precision', 'negativeFormat', 'dateStyle']);
  if (Object.keys(format).some((key) => !allowedKeys.has(key))) return null;

  const result: {
    locale?: string;
    currency?: string;
    precision?: number;
    negativeFormat?: 'minus' | 'parentheses';
    dateStyle?: 'full' | 'long' | 'medium' | 'short';
  } = {};
  if (Object.hasOwn(format, 'locale')) {
    if (typeof format.locale !== 'string' || format.locale.length > 40) return null;
    try {
      new Intl.NumberFormat(format.locale);
    } catch {
      return null;
    }
    result.locale = format.locale;
  }
  if (Object.hasOwn(format, 'currency')) {
    if (typeof format.currency !== 'string' || !/^[A-Z]{3}$/.test(format.currency)) return null;
    try {
      new Intl.NumberFormat('en', { style: 'currency', currency: format.currency });
    } catch {
      return null;
    }
    result.currency = format.currency;
  }
  if (Object.hasOwn(format, 'precision')) {
    if (typeof format.precision !== 'number' || !Number.isInteger(format.precision) || format.precision < 0 || format.precision > 8)
      return null;
    result.precision = format.precision;
  }
  if (Object.hasOwn(format, 'negativeFormat')) {
    if (format.negativeFormat !== 'minus' && format.negativeFormat !== 'parentheses') return null;
    result.negativeFormat = format.negativeFormat;
  }
  if (Object.hasOwn(format, 'dateStyle')) {
    if (!['full', 'long', 'medium', 'short'].includes(String(format.dateStyle))) return null;
    result.dateStyle = format.dateStyle as NonNullable<typeof result.dateStyle>;
  }
  return result;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
