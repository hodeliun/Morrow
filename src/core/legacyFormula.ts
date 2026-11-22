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
  /** Optional validated label shown next to a calculated scalar result. */
  readonly name?: string;
  readonly formula: string;
  readonly outputType: string;
  /** Unknown or unsupported format keys are represented as null, never forwarded. */
  readonly format: Readonly<LegacyFormulaDisplayFormat> | null;
  readonly fallback: string;
}

export interface LegacyFormulaMarkerInput {
  readonly resultId: string;
  readonly pageId: string;
  readonly formula: string;
  readonly name?: string;
}

/** Host-only projection used to open the editor for an already validated scalar result. */
export interface LegacyFormulaEditValues {
  readonly resultId: string;
  readonly pageId: string;
  readonly name: string;
  readonly formula: string;
  readonly outputType: string;
  readonly format: Readonly<LegacyFormulaDisplayFormat>;
}

export interface LegacyFormulaEditInput {
  readonly name: string;
  readonly formula: string;
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
  readonly encodedPayloadStart: number;
  readonly encodedPayloadEnd: number;
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
    ...(payload.name.trim() ? { name: payload.name } : {}),
    formula: payload.formula,
    outputType: payload.outputType,
    format: projectDisplayFormat(payload.format),
    fallback: marker.fallback,
  };
}

/** Reads only published, unbound scalar results whose renderer supports the stored format. */
export function parseEditableLegacyFormula(raw: string, fallback: string): LegacyFormulaEditValues | null {
  const marker = parseLegacyFormulaMarker(raw);
  if (!marker || marker.raw !== raw || marker.fallback !== fallback) return null;
  const opening = parseLegacyFormulaOpeningTag(raw);
  if (!opening) return null;
  let payloadText: string;
  try {
    payloadText = decodeURIComponent(opening.encodedPayload);
  } catch {
    return null;
  }
  if (!topLevelStringValueRange(payloadText, 'formula') || !topLevelStringValueRange(payloadText, 'name')) return null;
  const payload = decodePayload(opening.encodedPayload);
  const format = payload ? projectDisplayFormat(payload.format) : null;
  if (
    !payload ||
    payload.bindings.length !== 0 ||
    !EDITABLE_OUTPUT_TYPES.has(payload.outputType) ||
    !format ||
    !formatSupportsOutput(payload.outputType, payload.format)
  ) return null;
  return {
    resultId: payload.resultId,
    pageId: payload.pageId,
    name: payload.name,
    formula: payload.formula,
    outputType: payload.outputType,
    format,
  };
}

/** Replaces only the two top-level JSON strings and, when renamed, its escaped fallback text. */
export function updateLegacyFormulaMarker(
  raw: string,
  fallback: string,
  input: LegacyFormulaEditInput,
): LegacyFormulaMarker | null {
  const current = parseEditableLegacyFormula(raw, fallback);
  const opening = parseLegacyFormulaOpeningTag(raw);
  if (
    !current || !opening ||
    !input || typeof input.formula !== 'string' || input.formula.length > 2000 ||
    typeof input.name !== 'string' || input.name.length > 100
  ) return null;
  if (input.formula === current.formula && input.name === current.name) return { raw, fallback, resultId: current.resultId };

  let decodedPayload: DecodedUriText;
  try {
    decodedPayload = decodeUriTextWithOffsets(opening.encodedPayload);
  } catch {
    return null;
  }
  const formulaRange = topLevelStringValueRange(decodedPayload.text, 'formula');
  const nameRange = topLevelStringValueRange(decodedPayload.text, 'name');
  if (!formulaRange || !nameRange) return null;

  const replacements: Array<{
    readonly range: { readonly start: number; readonly end: number };
    readonly value: string;
  }> = [];
  if (input.formula !== current.formula) {
    replacements.push({
      range: mapDecodedRangeToEncoded(formulaRange, decodedPayload),
      value: encodeURIComponent(JSON.stringify(input.formula)).replaceAll("'", '%27'),
    });
  }
  if (input.name !== current.name) {
    replacements.push({
      range: mapDecodedRangeToEncoded(nameRange, decodedPayload),
      value: encodeURIComponent(JSON.stringify(input.name)).replaceAll("'", '%27'),
    });
  }
  replacements.sort((left, right) => right.range.start - left.range.start);
  let encodedPayload = opening.encodedPayload;
  for (const replacement of replacements) {
    encodedPayload =
      encodedPayload.slice(0, replacement.range.start) +
      replacement.value +
      encodedPayload.slice(replacement.range.end);
  }

  const updatedOpening =
    raw.slice(0, opening.encodedPayloadStart) +
    encodedPayload +
    raw.slice(opening.encodedPayloadEnd, opening.end);
  const fallbackStart = opening.end;
  const fallbackEnd = raw.indexOf('<', fallbackStart);
  if (fallbackEnd < 0) return null;
  const innerText = input.name === current.name ? raw.slice(fallbackStart, fallbackEnd) : escapeHtmlText(input.name);
  return parseLegacyFormulaMarker(updatedOpening + innerText + raw.slice(fallbackEnd));
}

/** Builds the published scalar marker shape while keeping its label inert HTML text. */
export function createLegacyFormulaMarker(input: LegacyFormulaMarkerInput): LegacyFormulaMarker | null {
  if (
    !input ||
    typeof input.resultId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.resultId) ||
    typeof input.pageId !== 'string' ||
    input.pageId.length === 0 ||
    typeof input.formula !== 'string' ||
    input.formula.length > 2000 ||
    (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 100))
  )
    return null;

  const name = input.name ?? '';
  const payload = {
    resultId: input.resultId,
    pageId: input.pageId,
    name,
    formula: input.formula,
    bindings: [],
    outputType: 'auto',
    format: {},
  };
  try {
    const encoded = encodeURIComponent(JSON.stringify(payload)).replaceAll("'", '%27');
    const fallback = name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return parseLegacyFormulaMarker(`<span data-morrow-result="${encoded}">${fallback}</span>`);
  } catch {
    return null;
  }
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
  let encodedPayloadStart = -1;
  let encodedPayloadEnd = -1;

  while (index < source.length) {
    if (index - start > MAX_MARKER_LENGTH) return null;
    while (index < source.length && index - start <= MAX_MARKER_LENGTH && /\s/.test(source[index]!)) index++;
    if (source[index] === '>') {
      if (encodedPayload === null) return null;
      return { end: index + 1, encodedPayload, encodedPayloadStart, encodedPayloadEnd };
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
    let valueStart: number;
    let valueEnd: number;
    if (quote) {
      valueStart = ++index;
      while (index < source.length && source[index] !== quote) {
        if (index - start > MAX_MARKER_LENGTH) return null;
        index++;
      }
      if (index >= source.length) return null;
      value = source.slice(valueStart, index);
      valueEnd = index;
      index++;
    } else {
      valueStart = index;
      while (
        index < source.length &&
        index - start <= MAX_MARKER_LENGTH &&
        !/[\s>]/.test(source[index]!)
      ) {
        index++;
      }
      if (index === valueStart) return null;
      value = source.slice(valueStart, index);
      valueEnd = index;
    }
    if (name === 'data-morrow-result') {
      if (encodedPayload !== null) return null;
      encodedPayload = value;
      encodedPayloadStart = valueStart;
      encodedPayloadEnd = valueEnd;
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
  pageId: string;
  name: string;
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
      pageId: parsed.pageId,
      name: parsed.name,
      formula: parsed.formula,
      bindings: parsed.bindings,
      outputType: parsed.outputType,
      format: parsed.format,
    };
  } catch {
    return null;
  }
}

const EDITABLE_OUTPUT_TYPES = new Set(['auto', 'text', 'number', 'currency', 'percent', 'checkbox', 'date']);

function formatSupportsOutput(outputType: string, format: Record<string, unknown>): boolean {
  const keys = Object.keys(format);
  switch (outputType) {
    case 'auto':
    case 'text':
      return keys.every((key) => ['locale', 'currency', 'precision', 'negativeFormat'].includes(key));
    case 'number':
    case 'currency':
    case 'percent':
      return keys.every((key) => ['locale', 'currency', 'precision', 'negativeFormat'].includes(key));
    case 'checkbox':
      return keys.length === 0;
    case 'date':
      return keys.every((key) => key === 'locale' || key === 'dateStyle');
    default:
      return false;
  }
}

function topLevelStringValueRange(
  source: string,
  property: string,
): { readonly start: number; readonly end: number } | null {
  let index = skipJsonWhitespace(source, 0);
  if (source[index] !== '{') return null;
  index = skipJsonWhitespace(source, index + 1);
  let found: { readonly start: number; readonly end: number } | null = null;
  while (index < source.length && source[index] !== '}') {
    if (source[index] !== '"') return null;
    const keyEnd = jsonStringEnd(source, index);
    if (keyEnd === null) return null;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(index, keyEnd));
    } catch {
      return null;
    }
    index = skipJsonWhitespace(source, keyEnd);
    if (source[index] !== ':') return null;
    index = skipJsonWhitespace(source, index + 1);
    const valueStart = index;
    if (key === property) {
      if (found || source[valueStart] !== '"') return null;
      const valueEnd = jsonStringEnd(source, valueStart);
      if (valueEnd === null) return null;
      found = { start: valueStart, end: valueEnd };
      index = valueEnd;
    } else {
      const valueEnd = jsonValueEnd(source, valueStart);
      if (valueEnd === null) return null;
      index = valueEnd;
    }
    index = skipJsonWhitespace(source, index);
    if (source[index] === ',') index = skipJsonWhitespace(source, index + 1);
    else if (source[index] !== '}') return null;
  }
  return found;
}

interface DecodedUriText {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

function decodeUriTextWithOffsets(encoded: string): DecodedUriText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (let index = 0; index < encoded.length;) {
    const start = index;
    let decoded: string;
    if (encoded[index] === '%') {
      if (!/^%[\da-f]{2}$/i.test(encoded.slice(index, index + 3))) throw new Error('Invalid URI encoding.');
      const firstByte = Number.parseInt(encoded.slice(index + 1, index + 3), 16);
      const byteLength = firstByte < 0x80 ? 1 : firstByte < 0xe0 ? 2 : firstByte < 0xf0 ? 3 : 4;
      const end = index + byteLength * 3;
      const sequence = encoded.slice(index, end);
      if (sequence.match(/%[\da-f]{2}/gi)?.length !== byteLength) throw new Error('Invalid UTF-8 URI sequence.');
      decoded = decodeURIComponent(sequence);
      index = end;
    } else {
      const codePoint = encoded.codePointAt(index);
      if (codePoint === undefined) throw new Error('Invalid URI text.');
      decoded = String.fromCodePoint(codePoint);
      index += decoded.length;
    }
    text += decoded;
    for (let offset = 0; offset < decoded.length; offset++) {
      starts.push(start);
      ends.push(index);
    }
  }
  if (decodeURIComponent(encoded) !== text) throw new Error('URI decoding changed the source text.');
  return { text, starts, ends };
}

function mapDecodedRangeToEncoded(
  range: { readonly start: number; readonly end: number },
  decoded: DecodedUriText,
): { readonly start: number; readonly end: number } {
  const start = decoded.starts[range.start];
  const end = decoded.ends[range.end - 1];
  if (start === undefined || end === undefined) throw new Error('The JSON value has no encoded source range.');
  return { start, end };
}

function jsonValueEnd(source: string, start: number): number | null {
  if (source[start] === '"') return jsonStringEnd(source, start);
  if (source[start] !== '{' && source[start] !== '[') {
    let end = start;
    while (end < source.length && !/[\s,}\]]/.test(source[end]!)) end++;
    return end > start ? end : null;
  }
  const opening = source[start];
  const stack = [opening === '{' ? '}' : ']'];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') stack.push('}');
    else if (char === '[') stack.push(']');
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return index + 1;
    }
  }
  return null;
}

function jsonStringEnd(source: string, start: number): number | null {
  if (source[start] !== '"') return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]!;
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') return index + 1;
  }
  return null;
}

function skipJsonWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index]!)) index++;
  return index;
}

function escapeHtmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
