import { isAlias, isMap, isPair, isScalar, parse, parseDocument, stringify } from 'yaml';
import { isRecord } from '../doc';
import { isValidNoteStyle, isValidNoteStyleInput } from '../noteStyle';
import type { NoteStyle } from '../noteStyle';

const NOTE_STYLE_FIELDS = ['font', 'fontSize', 'lineHeight', 'blockSpacing', 'width'] as const;
type NoteStyleField = (typeof NOTE_STYLE_FIELDS)[number];

// frontmatter keys morrow reads and writes, every other key is kept exactly as it was
export const MANAGED_KEYS = new Set(['title', 'icon', 'kind', 'tags', 'tag', 'database', 'cover']);
const MAX_KEY_LENGTH = 200;
const MAX_EXTRA_KEYS = 200;

// the frontmatter key matching a property name, its exact spelling first, then ignoring case like obsidian
export function findKey(data: Record<string, unknown>, name: string): string | undefined {
  if (Object.hasOwn(data, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(data).find((key) => key.toLowerCase() === lower);
}

// keeps only plain values under usable keys, so a hostile backup or command can not put anything odd in a file
export function normalizeExtra(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_EXTRA_KEYS) break;
    const clean = key.trim();
    if (!clean || clean !== key || key.length > MAX_KEY_LENGTH || MANAGED_KEYS.has(key)) continue;
    const plain = plainValue(value, 0);
    if (plain !== undefined) out[key] = plain;
  }
  return out;
}

function plainValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 8) return undefined;
  if (Array.isArray(value))
    return value.slice(0, 1000).flatMap((item) => {
      const plain = plainValue(item, depth + 1);
      return plain === undefined ? [] : [plain];
    });
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const plain = plainValue(item, depth + 1);
      if (plain !== undefined) out[key] = plain;
    }
    return out;
  }
  return undefined;
}

// the frontmatter most notes have, keys with plain values and simple lists, read without the full yaml
// parser, which is most of the time spent opening a big vault. anything else, or anything this can't
// be sure reads the same as yaml would, returns null and goes to the real parser
const SIMPLE_KEY = /^([A-Za-z_][\w -]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const SIMPLE_ITEM = /^([ \t]*)-[ \t]+(.*?)[ \t]*$/;
// a plain scalar with no character yaml gives a meaning to
const PLAIN = /^[A-Za-z0-9_+-][\w ./+,-]*$/;
const INT = /^[-+]?[0-9]+$/;
const FLOAT = /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/;
const UNSURE = undefined;

function plainScalar(text: string, inList: boolean): unknown {
  if (text === '' || text === '~' || /^(?:null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (!PLAIN.test(text) || (inList && text.includes(',')) || /^-[ \t]/.test(text)) return UNSURE;
  // hex and octal numbers
  if (/^[-+]?0[xXoO]/.test(text)) return UNSURE;
  if (INT.test(text) || FLOAT.test(text)) return Number(text);
  return text;
}

export function parseSimple(yaml: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  // the key a block list can still follow, and the indent its items use
  let open: { key: string; indent: string | null } | null = null;
  for (const line of yaml.split('\n')) {
    if (!line.trim()) continue;
    const item = open ? SIMPLE_ITEM.exec(line) : null;
    if (open && item) {
      if (open.indent !== null && item[1] !== open.indent) return null;
      open.indent = item[1]!;
      const value = plainScalar(item[2]!, false);
      if (value === UNSURE || value === null) return null;
      const list = out[open.key];
      if (Array.isArray(list)) list.push(value);
      else out[open.key] = [value];
      continue;
    }
    open = null;
    if (line.startsWith(' ') || line.startsWith('\t')) return null;
    const pair = SIMPLE_KEY.exec(line);
    if (!pair) return null;
    const key = pair[1]!;
    if (Object.hasOwn(out, key)) return null;
    const raw = pair[2] ?? '';
    if (raw === '') {
      // a key alone is null, unless a list follows on the next lines
      out[key] = null;
      open = { key, indent: null };
      continue;
    }
    const flow = /^\[(.*)\]$/.exec(raw);
    if (flow) {
      const inner = flow[1]!.trim();
      const items = inner ? inner.split(',').map((part) => plainScalar(part.trim(), true)) : [];
      if (items.some((value) => value === UNSURE || value === null)) return null;
      out[key] = items;
      continue;
    }
    const value = plainScalar(raw, false);
    if (value === UNSURE) return null;
    out[key] = value;
  }
  return out;
}

export interface SplitFile {
  // null when the file has no frontmatter
  data: Record<string, unknown> | null;
  // the frontmatter block exactly as written, reused when its values did not change
  head: string;
  // the yaml inside it
  yaml: string;
  body: string;
  // set when frontmatter exists but is not valid yaml, the file is then left alone
  error: string | null;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): SplitFile {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const open = OPEN.exec(source);
  if (!open) return { data: null, head: '', yaml: '', body: source, error: null };
  // the leading newline lets an empty block close on the very next line
  const rest = `\n${source.slice(open[0].length)}`;
  const match = CLOSE.exec(rest);
  if (!match) return { data: null, head: '', yaml: '', body: source, error: null };
  const yaml = rest.slice(1, Math.max(1, match.index));
  const body = rest.slice(match.index + match[0].length);
  const head = source.slice(0, source.length - body.length);
  if (!yaml.trim()) return { data: {}, head, yaml, body, error: null };
  try {
    const data: unknown = parseSimple(yaml) ?? parse(yaml, { maxAliasCount: 100, uniqueKeys: false });
    if (data === null || data === undefined) return { data: {}, head, yaml, body, error: null };
    if (!isRecord(data))
      return {
        data: null,
        head,
        yaml,
        body,
        error: 'The properties at the top of the file are not a list of keys.',
      };
    return { data, head, yaml, body, error: null };
  } catch (error) {
    return {
      data: null,
      head,
      yaml,
      body,
      error: `The properties at the top of the file could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    };
  }
}

// the body is kept byte for byte, so a file only changes where its properties changed
export function joinFrontmatter(data: Record<string, unknown> | null, body: string): string {
  if (!data || Object.keys(data).length === 0) return body;
  const yaml = stringify(data, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
  return `---\n${yaml}---\n${body}`;
}

export function isUnambiguousFrontmatter(yaml: string, expected: Record<string, unknown>): boolean {
  try {
    const parsed = parse(yaml, { maxAliasCount: 100, uniqueKeys: true }) ?? {};
    return isRecord(parsed) && same(parsed, expected);
  } catch {
    return false;
  }
}

// changes only the keys whose values changed, so every other line keeps its exact formatting and comments.
// null when the yaml can not be edited that way, then the whole block is written again
export function updateFrontmatter(
  yaml: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  body: string,
  optedInCheckboxKeys: ReadonlySet<string> = new Set(),
  preserveRawKeys: ReadonlySet<string> = new Set(),
  verifyUnchangedValues = false,
): string | null {
  const changedCheckboxKeys = [...optedInCheckboxKeys].filter((name) => {
    const beforeKey = findKey(before, name);
    const afterKey = findKey(after, name);
    if (beforeKey === undefined) return afterKey !== undefined;
    if (afterKey === undefined) return true;
    return !same(before[beforeKey], after[afterKey]);
  });
  if (Object.keys(after).length === 0 && changedCheckboxKeys.length === 0 && !verifyUnchangedValues)
    return body;
  const order = Object.keys(after);
  const kept = Object.keys(before).filter((key) => Object.hasOwn(after, key));
  // a key that moved, such as one renamed into another's place, is easier to get right by writing it all
  if (kept.some((key, index) => order[index] !== key)) return null;
  try {
    if (verifyUnchangedValues) {
      // Existing metadata must have one unambiguous effective value before it can be patched.
      // This is deliberately a write-time check; the normal reader still accepts legacy YAML.
      if (!isUnambiguousFrontmatter(yaml, before)) return null;
    }
    if (Object.keys(after).length === 0 && changedCheckboxKeys.length === 0) return body;

    const document = parseDocument(yaml, { uniqueKeys: false });
    if (document.errors.length > 0) return null;
    if (!document.contents) {
      if (verifyUnchangedValues ? Object.keys(before).length > 0 : changedCheckboxKeys.length === 0)
        return null;
    }
    if (verifyUnchangedValues && document.contents && !isMap(document.contents)) return null;
    if (changedCheckboxKeys.length > 0) {
      if (document.contents && !isMap(document.contents)) return null;
      if (isMap(document.contents)) {
        for (const name of changedCheckboxKeys) {
          const matchingPairs = document.contents.items.filter((item) => {
            if (!isPair(item)) return false;
            const pair = item;
            const key = isAlias(pair.key) ? pair.key.resolve(document) : isScalar(pair.key) ? pair.key : null;
            return (
              isScalar(key) && typeof key.value === 'string' && key.value.toLowerCase() === name.toLowerCase()
            );
          });
          if (matchingPairs.length > 1) return null;
        }
      }
    }
    for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) document.delete(key);
    for (const [key, value] of Object.entries(after)) {
      if (Object.hasOwn(before, key) && same(before[key], value)) continue;
      // a changed value keeps its quoting, except an empty one, whose quotes only meant empty
      const blank = before[key] === '' || before[key] === null;
      document.set(key, blank ? document.createNode(value) : value);
      if (changedCheckboxKeys.some((checkboxKey) => checkboxKey.toLowerCase() === key.toLowerCase())) {
        const valueNode = document.get(key, true);
        if (isScalar(valueNode) && valueNode.tag === 'tag:yaml.org,2002:str') valueNode.tag = undefined;
      }
    }
    if (verifyUnchangedValues && !isMap(document.contents)) return null;
    let text = document.toString({
      lineWidth: 0,
      defaultStringType: 'PLAIN',
      defaultKeyType: 'PLAIN',
      flowCollectionPadding: false,
    });
    if (changedCheckboxKeys.length > 0) {
      text = restoreUnchangedScalarLines(yaml, text, before, after, changedCheckboxKeys, preserveRawKeys);
      const parsed = parse(text, { maxAliasCount: 100, uniqueKeys: false }) ?? {};
      if (!isRecord(parsed) || !same(parsed, after)) return null;
    }
    if (verifyUnchangedValues) {
      // Equality checks presence and the effective value of every key, including untouched aliases.
      if (!isUnambiguousFrontmatter(text, after)) return null;
    }
    if (Object.keys(after).length === 0) return body;
    return `---\n${text}${text.endsWith('\n') ? '' : '\n'}---\n${body}`;
  } catch {
    return null;
  }
}

/**
 * Updates only the owned members of `morrowNoteStyle`, keeping the original body and unrelated YAML
 * nodes in place. A duplicate or unsupported style representation is refused instead of rewritten.
 */
export function updateMorrowNoteStyleFile(text: string, style: NoteStyle): string | null {
  if (!isValidNoteStyle(style)) return null;
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? text.slice(1) : text;
  const split = splitFrontmatter(source);
  if (split.error) return null;

  // No frontmatter is safe to extend. An opener without a matching close is malformed and must stay put.
  if (split.head === '') {
    if (/^---[ \t]*\r?\n/.test(source)) return null;
    return `${bom}${joinFrontmatter({ morrowNoteStyle: style }, split.body)}`;
  }
  if (!split.data || !isUnambiguousFrontmatter(split.yaml, split.data)) return null;

  const current = split.data.morrowNoteStyle;
  if (current !== undefined && !isRecord(current)) return null;
  const document = parseDocument(split.yaml, { uniqueKeys: true });
  if (document.errors.length > 0) return null;
  const root = document.contents;
  if (!isMap(root) && !(root === null && current === undefined)) return null;
  const stylePair = isMap(root)
    ? root.items.find((item) => isPair(item) && isScalar(item.key) && item.key.value === 'morrowNoteStyle')
    : undefined;
  const lineBreak = (split.head || source).includes('\r\n') ? '\r\n' : '\n';
  let yaml = split.yaml;
  if (!stylePair) {
    const block = [
      'morrowNoteStyle:',
      ...NOTE_STYLE_FIELDS.map((field) => `  ${field}: ${encodeStyleScalar(style[field])}`),
    ].join(lineBreak);
    const separator = split.yaml.length > 0 && !split.yaml.endsWith('\n') ? lineBreak : '';
    yaml = `${split.yaml}${separator}${block}`;
  } else {
    if (!isPair(stylePair) || !isMap(stylePair.value) || stylePair.value.flow) return null;
    const values = new Map<string, { start: number; end: number }>();
    for (const item of stylePair.value.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') continue;
      const key = item.key.value;
      if (!NOTE_STYLE_FIELDS.includes(key as NoteStyleField)) continue;
      if (values.has(key) || !isScalar(item.value) || isAlias(item.value) || !item.value.range) return null;
      values.set(key, { start: item.value.range[0], end: item.value.range[1] });
    }

    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const field of NOTE_STYLE_FIELDS) {
      const range = values.get(field);
      if (range) edits.push({ ...range, text: encodeStyleScalar(style[field]) });
    }

    const missing = NOTE_STYLE_FIELDS.filter((field) => !values.has(field));
    if (missing.length > 0) {
      const last = stylePair.value.items[stylePair.value.items.length - 1];
      const endNode = last && isPair(last) ? (last.value ?? last.key) : stylePair.key;
      const offset = lineEndAfter(yaml, endNode?.range?.[1] ?? stylePair.key.range?.[1] ?? 0);
      const first = stylePair.value.items.find((item) => isPair(item) && item.key.range);
      const firstKey = first && isPair(first) ? first.key.range?.[0] : undefined;
      const indent = firstKey === undefined ? '  ' : leadingIndent(yaml, firstKey);
      const addition = missing
        .map((field) => `${indent}${field}: ${encodeStyleScalar(style[field])}${lineBreak}`)
        .join('');
      const separator = offset === yaml.length && offset > 0 && !yaml.endsWith('\n') ? lineBreak : '';
      edits.push({ start: offset, end: offset, text: `${separator}${addition}` });
    }
    for (const edit of edits.sort((a, b) => b.start - a.start))
      yaml = `${yaml.slice(0, edit.start)}${edit.text}${yaml.slice(edit.end)}`;
  }

  const expected = {
    ...split.data,
    morrowNoteStyle: { ...(isRecord(current) ? current : {}), ...style },
  };
  if (!isUnambiguousFrontmatter(yaml, expected)) return null;
  const opening = OPEN.exec(source);
  if (!opening) return null;
  const rest = `\n${source.slice(opening[0].length)}`;
  const closing = CLOSE.exec(rest);
  if (!closing) return null;
  const closeStart = opening[0].length + closing.index - 1;
  const updated = `${source.slice(0, opening[0].length)}${yaml}${source.slice(closeStart)}`;
  const verified = splitFrontmatter(updated);
  if (
    verified.error ||
    !verified.data ||
    !isUnambiguousFrontmatter(verified.yaml, expected) ||
    verified.body !== split.body
  )
    return null;
  return `${bom}${updated}`;
}

/**
 * The exact scalar source for fields present in a note's explicit style before a batch apply.
 * Missing fields are absent from `fields`; an own property with an empty or `null` scalar stays present.
 */
export interface ExplicitMorrowNoteStyleSnapshot {
  readonly kind: 'explicit';
  readonly fields: Readonly<Partial<Record<NoteStyleField, string>>>;
  /** True when the writer must add a line break before appended style fields. */
  readonly separatorAdded: boolean;
  /** The existing nested key whose line ended the YAML before that separator was added. */
  readonly separatorAnchorKey: string | null;
}

/** Captures a safe explicit style override without normalizing its scalar spellings. */
export function captureExplicitMorrowNoteStyleFile(text: string): ExplicitMorrowNoteStyleSnapshot | null {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const split = splitFrontmatter(source);
  if (!split.head || split.error || !split.data || !isUnambiguousFrontmatter(split.yaml, split.data))
    return null;

  const document = parseDocument(split.yaml, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents) || document.contents.flow) return null;
  const stylePairs = document.contents.items.filter(
    (item) => isPair(item) && isScalar(item.key) && item.key.value === 'morrowNoteStyle',
  );
  if (stylePairs.length !== 1) return null;
  const stylePair = stylePairs[0];
  if (
    !stylePair ||
    !isPair(stylePair) ||
    !isScalar(stylePair.key) ||
    !stylePair.key.range ||
    !isMap(stylePair.value) ||
    stylePair.value.flow ||
    !stylePair.value.range ||
    hasYamlAnchorOrAlias(stylePair)
  )
    return null;

  const fields: Partial<Record<NoteStyleField, string>> = {};
  for (const item of stylePair.value.items) {
    if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') continue;
    const key = item.key.value;
    if (key === '<<') return null;
    if (!NOTE_STYLE_FIELDS.includes(key as NoteStyleField)) continue;
    if (
      Object.hasOwn(fields, key) ||
      !isScalar(item.value) ||
      isAlias(item.value) ||
      hasExplicitYamlTag(item.key) ||
      hasExplicitYamlTag(item.value) ||
      !item.key.range ||
      !item.value.range
    )
      return null;

    const keyLine = lineBounds(split.yaml, item.key.range[0]);
    const valueLine = lineBounds(split.yaml, item.value.range[0]);
    const valueEndLine = lineBounds(split.yaml, item.value.range[1]);
    if (
      keyLine.start !== valueLine.start ||
      keyLine.end !== valueLine.end ||
      keyLine.start !== valueEndLine.start ||
      keyLine.end !== valueEndLine.end
    )
      return null;

    const colon = split.yaml.indexOf(':', item.key.range[1]);
    if (
      colon < item.key.range[1] ||
      colon >= keyLine.end ||
      split.yaml.slice(item.key.range[1], colon).trim() !== ''
    )
      return null;
    const raw = split.yaml.slice(colon + 1, item.value.range[1]);
    if (/[\r\n]/.test(raw) || readStyleScalarLexeme(raw) === null) return null;
    fields[key as NoteStyleField] = raw;
  }

  const missingFields = NOTE_STYLE_FIELDS.filter((field) => !Object.hasOwn(fields, field));
  const lastItem = stylePair.value.items[stylePair.value.items.length - 1];
  const endNode = lastItem && isPair(lastItem) ? (lastItem.value ?? lastItem.key) : stylePair.key;
  const offset = lineEndAfter(split.yaml, endNode?.range?.[1] ?? stylePair.key.range[1]);
  const separatorAdded =
    missingFields.length > 0 && offset === split.yaml.length && offset > 0 && !split.yaml.endsWith('\n');
  const anchorKey = lastItem && isPair(lastItem) && isScalar(lastItem.key) ? lastItem.key.value : null;
  if (separatorAdded && typeof anchorKey !== 'string') return null;
  const separatorAnchorKey = separatorAdded && typeof anchorKey === 'string' ? anchorKey : null;

  return {
    kind: 'explicit',
    fields,
    separatorAdded,
    separatorAnchorKey,
  };
}

/** Restores an earlier explicit override while keeping the current Markdown and unrelated YAML edits. */
export function restoreExplicitMorrowNoteStyleFile(
  text: string,
  appliedStyle: NoteStyle,
  snapshot: ExplicitMorrowNoteStyleSnapshot,
): string | null {
  if (!isValidNoteStyleInput(appliedStyle) || !isValidExplicitStyleSnapshot(snapshot)) return null;

  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? text.slice(1) : text;
  const split = splitFrontmatter(source);
  if (!split.head || split.error || !split.data || !isUnambiguousFrontmatter(split.yaml, split.data))
    return null;
  const currentStyle = split.data.morrowNoteStyle;
  if (!isRecord(currentStyle) || !matchesAppliedNoteStyleValues(currentStyle, appliedStyle)) return null;

  const document = parseDocument(split.yaml, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents) || document.contents.flow) return null;
  const stylePairs = document.contents.items.filter(
    (item) => isPair(item) && isScalar(item.key) && item.key.value === 'morrowNoteStyle',
  );
  if (stylePairs.length !== 1) return null;
  const stylePair = stylePairs[0];
  if (
    !stylePair ||
    !isPair(stylePair) ||
    !isScalar(stylePair.key) ||
    !stylePair.key.range ||
    !isMap(stylePair.value) ||
    stylePair.value.flow ||
    !stylePair.value.range ||
    hasYamlAnchorOrAlias(stylePair)
  )
    return null;

  const currentPairs = new Map<NoteStyleField, unknown>();
  for (const item of stylePair.value.items) {
    if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') continue;
    const key = item.key.value;
    if (key === '<<') return null;
    if (!NOTE_STYLE_FIELDS.includes(key as NoteStyleField)) continue;
    if (
      currentPairs.has(key as NoteStyleField) ||
      !isScalar(item.value) ||
      isAlias(item.value) ||
      !item.key.range ||
      !item.value.range
    )
      return null;
    currentPairs.set(key as NoteStyleField, item);
  }
  if (!NOTE_STYLE_FIELDS.every((field) => currentPairs.has(field))) return null;

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const restoredStyle: Record<string, unknown> = { ...currentStyle };
  for (const field of NOTE_STYLE_FIELDS) {
    const pair = currentPairs.get(field);
    if (
      !pair ||
      !isPair(pair) ||
      !isScalar(pair.key) ||
      !pair.key.range ||
      !isScalar(pair.value) ||
      !pair.value.range
    )
      return null;
    if (hasExplicitYamlTag(pair.key) || hasExplicitYamlTag(pair.value)) return null;
    const keyLine = lineBounds(split.yaml, pair.key.range[0]);
    const valueLine = lineBounds(split.yaml, pair.value.range[0]);
    const valueEndLine = lineBounds(split.yaml, pair.value.range[1]);
    if (
      keyLine.start !== valueLine.start ||
      keyLine.end !== valueLine.end ||
      keyLine.start !== valueEndLine.start ||
      keyLine.end !== valueEndLine.end
    )
      return null;
    const colon = split.yaml.indexOf(':', pair.key.range[1]);
    if (
      colon < pair.key.range[1] ||
      colon >= keyLine.end ||
      split.yaml.slice(pair.key.range[1], colon).trim() !== ''
    )
      return null;

    if (Object.hasOwn(snapshot.fields, field)) {
      const raw = snapshot.fields[field]!;
      const priorValue = readStyleScalarLexeme(raw);
      if (priorValue === null) return null;
      edits.push({ start: colon + 1, end: pair.value.range[1], text: raw });
      restoredStyle[field] = priorValue.value;
    } else {
      const lineStartAt = lineStart(split.yaml, pair.key.range[0]);
      if (
        split.yaml.slice(lineStartAt, pair.key.range[0]).trim() !== '' ||
        split.yaml.slice(pair.value.range[1], keyLine.end).trim() !== ''
      )
        return null;
      edits.push({ start: lineStartAt, end: lineEndAfter(split.yaml, pair.key.range[0]), text: '' });
      delete restoredStyle[field];
    }
  }

  let yaml = split.yaml;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    yaml = `${yaml.slice(0, edit.start)}${edit.text}${yaml.slice(edit.end)}`;

  if (snapshot.separatorAdded) {
    const cleaned = removeAddedStyleSeparator(yaml, snapshot.separatorAnchorKey);
    if (cleaned === null) return null;
    yaml = cleaned;
  }

  const expected = { ...split.data, morrowNoteStyle: restoredStyle };
  if (!isUnambiguousFrontmatter(yaml, expected)) return null;
  const opening = OPEN.exec(source);
  if (!opening) return null;
  const rest = `\n${source.slice(opening[0].length)}`;
  const closing = CLOSE.exec(rest);
  if (!closing) return null;
  const closeStart = opening[0].length + closing.index - 1;
  const updated = `${source.slice(0, opening[0].length)}${yaml}${source.slice(closeStart)}`;
  const verified = splitFrontmatter(updated);
  const restoredSnapshot = captureExplicitMorrowNoteStyleFile(updated);
  if (
    verified.error ||
    !verified.data ||
    !isUnambiguousFrontmatter(verified.yaml, expected) ||
    verified.body !== split.body ||
    !sameExplicitStyleSnapshot(restoredSnapshot, snapshot)
  )
    return null;
  return `${bom}${updated}`;
}

function isValidExplicitStyleSnapshot(value: unknown): value is ExplicitMorrowNoteStyleSnapshot {
  if (
    !isRecord(value) ||
    value.kind !== 'explicit' ||
    !isRecord(value.fields) ||
    typeof value.separatorAdded !== 'boolean' ||
    (value.separatorAdded ? typeof value.separatorAnchorKey !== 'string' : value.separatorAnchorKey !== null)
  )
    return false;
  for (const [field, raw] of Object.entries(value.fields)) {
    if (
      !NOTE_STYLE_FIELDS.includes(field as NoteStyleField) ||
      typeof raw !== 'string' ||
      readStyleScalarLexeme(raw) === null
    )
      return false;
  }
  return true;
}

function sameExplicitStyleSnapshot(
  value: ExplicitMorrowNoteStyleSnapshot | null,
  expected: ExplicitMorrowNoteStyleSnapshot,
): boolean {
  if (!value || value.kind !== expected.kind) return false;
  return NOTE_STYLE_FIELDS.every((field) => {
    const hasValue = Object.hasOwn(value.fields, field);
    const hasExpected = Object.hasOwn(expected.fields, field);
    return hasValue === hasExpected && (!hasValue || value.fields[field] === expected.fields[field]);
  });
}

function removeAddedStyleSeparator(yaml: string, anchorKey: string | null): string | null {
  if (anchorKey === null) return null;
  try {
    const document = parseDocument(yaml, { uniqueKeys: true });
    if (document.errors.length > 0 || !isMap(document.contents)) return null;
    const stylePair = document.contents.items.find(
      (item) => isPair(item) && isScalar(item.key) && item.key.value === 'morrowNoteStyle',
    );
    if (!isPair(stylePair) || !isMap(stylePair.value)) return null;
    const anchor = stylePair.value.items.find(
      (item) => isPair(item) && isScalar(item.key) && item.key.value === anchorKey,
    );
    if (!isPair(anchor)) return null;
    const nodeEnd = (anchor.value ?? anchor.key).range?.[1];
    if (nodeEnd === undefined) return null;
    const line = lineBounds(yaml, yaml[nodeEnd - 1] === '\n' ? nodeEnd - 1 : nodeEnd);
    const tail = yaml.slice(line.end);
    if (!tail || !/^\s*$/.test(tail)) return yaml;
    const lineBreak = /^(?:\r\n|\n)/.exec(tail);
    if (!lineBreak) return yaml;
    return `${yaml.slice(0, line.end)}${tail.slice(lineBreak[0].length)}`;
  } catch {
    return null;
  }
}

function readStyleScalarLexeme(raw: string): { readonly value: unknown } | null {
  if (/[\r\n]/.test(raw)) return null;
  try {
    const source = `value:${raw}\n`;
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0 || !isMap(document.contents) || document.contents.items.length !== 1)
      return null;
    const pair = document.contents.items[0];
    if (
      !pair ||
      !isPair(pair) ||
      !isScalar(pair.key) ||
      pair.key.value !== 'value' ||
      !isScalar(pair.value) ||
      isAlias(pair.value) ||
      !pair.value.range ||
      hasExplicitYamlTag(pair.key) ||
      hasExplicitYamlTag(pair.value) ||
      hasYamlComments(pair) ||
      hasYamlAnchorOrAlias(pair)
    )
      return null;
    const start = lineBounds(source, pair.value.range[0]);
    const end = lineBounds(source, pair.value.range[1]);
    if (start.start !== end.start || start.end !== end.end) return null;
    return { value: pair.value.value };
  } catch {
    return null;
  }
}

/** Decodes the prior explicit scalar values for the session's in-memory restore patch. */
export interface ExplicitMorrowNoteStylePatch {
  readonly set: Readonly<Partial<Record<NoteStyleField, unknown>>>;
  readonly remove: readonly NoteStyleField[];
}

export function decodeExplicitMorrowNoteStyleSnapshot(
  snapshot: ExplicitMorrowNoteStyleSnapshot,
): ExplicitMorrowNoteStylePatch | null {
  if (!isValidExplicitStyleSnapshot(snapshot)) return null;
  const set: Partial<Record<NoteStyleField, unknown>> = {};
  const remove: NoteStyleField[] = [];
  for (const field of NOTE_STYLE_FIELDS) {
    if (!Object.hasOwn(snapshot.fields, field)) {
      remove.push(field);
      continue;
    }
    const decoded = readStyleScalarLexeme(snapshot.fields[field]!);
    if (!decoded) return null;
    set[field] = decoded.value;
  }
  return { set, remove };
}

export interface MorrowNoteStyleRestoreContext {
  readonly hadFrontmatter: boolean;
  readonly separatorAdded: boolean;
  readonly emptyFrontmatterHadBlankLine: boolean | null;
}

/** Captures the small amount of source structure needed to undo adding an inherited note style. */
export function captureInheritedMorrowNoteStyleContext(text: string): MorrowNoteStyleRestoreContext | null {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const split = splitFrontmatter(source);
  if (split.error) return null;

  if (split.head === '') {
    if (OPEN.test(source)) return null;
    return {
      hadFrontmatter: false,
      separatorAdded: false,
      emptyFrontmatterHadBlankLine: null,
    };
  }
  if (!split.data || !isUnambiguousFrontmatter(split.yaml, split.data)) return null;
  if (Object.keys(split.data).some((key) => key.toLowerCase() === 'morrownotestyle')) return null;

  const opening = OPEN.exec(source);
  if (!opening) return null;
  const closing = CLOSE.exec(`\n${source.slice(opening[0].length)}`);
  if (!closing) return null;

  return {
    hadFrontmatter: true,
    separatorAdded: split.yaml.length > 0 && !split.yaml.endsWith('\n'),
    emptyFrontmatterHadBlankLine: split.yaml === '' ? closing.index > 0 : null,
  };
}

/** Removes an unchanged inherited-style override while preserving the current YAML and body. */
export function restoreInheritedMorrowNoteStyleFile(
  text: string,
  appliedStyle: NoteStyle,
  context: MorrowNoteStyleRestoreContext,
): string | null {
  if (
    !context ||
    typeof context.hadFrontmatter !== 'boolean' ||
    typeof context.separatorAdded !== 'boolean' ||
    (context.emptyFrontmatterHadBlankLine !== null &&
      typeof context.emptyFrontmatterHadBlankLine !== 'boolean') ||
    (!context.hadFrontmatter && context.separatorAdded) ||
    (!context.hadFrontmatter && context.emptyFrontmatterHadBlankLine !== null) ||
    !isValidNoteStyleInput(appliedStyle)
  )
    return null;

  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = bom ? text.slice(1) : text;
  const split = splitFrontmatter(source);
  if (split.error || !split.head || !split.data || !isUnambiguousFrontmatter(split.yaml, split.data))
    return null;

  const currentStyle = split.data.morrowNoteStyle;
  if (!sameNoteStyle(currentStyle, appliedStyle)) return null;

  const document = parseDocument(split.yaml, { uniqueKeys: true });
  if (document.errors.length > 0 || !isMap(document.contents)) return null;
  const stylePairs = document.contents.items.filter(
    (item) => isPair(item) && isScalar(item.key) && item.key.value === 'morrowNoteStyle',
  );
  if (stylePairs.length !== 1) return null;
  const stylePair = stylePairs[0];
  if (
    !stylePair ||
    !isPair(stylePair) ||
    !isScalar(stylePair.key) ||
    !stylePair.key.range ||
    stylePair.key.comment !== undefined ||
    !isMap(stylePair.value) ||
    stylePair.value.flow ||
    !stylePair.value.range ||
    hasYamlComments(stylePair.value) ||
    hasYamlAnchorOrAlias(stylePair.key) ||
    hasYamlAnchorOrAlias(stylePair.value) ||
    !hasExactStyleFields(stylePair.value)
  )
    return null;

  const start = lineStart(split.yaml, stylePair.key.range[0]);
  const lastStyleField = stylePair.value.items[stylePair.value.items.length - 1];
  if (
    !lastStyleField ||
    !isPair(lastStyleField) ||
    !isScalar(lastStyleField.value) ||
    !lastStyleField.value.range
  )
    return null;
  const end = lastStyleField.value.range[1];
  if (
    split.yaml.slice(start, stylePair.key.range[0]).trim() !== '' ||
    end <= start ||
    end > split.yaml.length
  )
    return null;

  let prefix = split.yaml.slice(0, start);
  const rawSuffix = split.yaml.slice(end);
  const { suffix, consumedTerminator } = consumeStyleLineTerminator(rawSuffix);
  const hadSuffix = consumedTerminator || suffix.length > 0;
  if (context.separatorAdded && !hadSuffix && prefix !== '') {
    const withoutSeparator = removeLineBreakBefore(prefix);
    if (withoutSeparator === null) return null;
    prefix = withoutSeparator;
  }
  const yaml = `${prefix}${suffix}`;
  if (!context.hadFrontmatter && yaml.trim() === '') {
    const unwrapped = splitFrontmatter(split.body);
    if (unwrapped.error || unwrapped.head !== '' || unwrapped.body !== split.body) return null;
    return `${bom}${split.body}`;
  }

  const expected = { ...split.data };
  delete expected.morrowNoteStyle;
  if (!isUnambiguousFrontmatter(yaml, expected)) return null;
  const opening = OPEN.exec(source);
  if (!opening) return null;
  const rest = `\n${source.slice(opening[0].length)}`;
  const closing = CLOSE.exec(rest);
  if (!closing) return null;
  const closeStart = opening[0].length + closing.index - 1;
  const closeLineEndingLength = closing[0].startsWith('\r\n') ? 2 : 1;
  const updated =
    yaml === '' && context.emptyFrontmatterHadBlankLine === false
      ? `${source.slice(0, opening[0].length)}${source.slice(closeStart + closeLineEndingLength)}`
      : `${source.slice(0, opening[0].length)}${yaml}${source.slice(closeStart)}`;
  const verified = splitFrontmatter(updated);
  if (
    verified.error ||
    !verified.data ||
    !isUnambiguousFrontmatter(verified.yaml, expected) ||
    verified.body !== split.body
  )
    return null;
  return `${bom}${updated}`;
}

export function sameNoteStyle(a: unknown, b: unknown): boolean {
  if (!isValidNoteStyleInput(a) || !isValidNoteStyleInput(b)) return false;
  return NOTE_STYLE_FIELDS.every((field) => a[field] === b[field]);
}

/** Compares the five applied values while allowing unknown fields carried by a newer writer. */
export function matchesAppliedNoteStyleValues(value: unknown, applied: NoteStyle): boolean {
  if (!isRecord(value) || !isValidNoteStyleInput(applied)) return false;
  return NOTE_STYLE_FIELDS.every((field) => Object.hasOwn(value, field) && value[field] === applied[field]);
}

function hasExactStyleFields(node: ReturnType<typeof parseDocument>['contents']): boolean {
  if (!isMap(node) || node.items.length !== NOTE_STYLE_FIELDS.length) return false;
  const fields = new Set<string>();
  for (const item of node.items) {
    if (
      !isPair(item) ||
      !isScalar(item.key) ||
      typeof item.key.value !== 'string' ||
      !NOTE_STYLE_FIELDS.includes(item.key.value as (typeof NOTE_STYLE_FIELDS)[number]) ||
      fields.has(item.key.value) ||
      !isScalar(item.value) ||
      isAlias(item.value)
    )
      return false;
    fields.add(item.key.value);
  }
  return NOTE_STYLE_FIELDS.every((field) => fields.has(field));
}

function hasYamlComments(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const candidate = node as {
    readonly comment?: unknown;
    readonly commentBefore?: unknown;
    readonly key?: unknown;
    readonly value?: unknown;
    readonly items?: readonly unknown[];
  };
  if (candidate.comment !== undefined || candidate.commentBefore !== undefined) return true;
  if (candidate.key && hasYamlComments(candidate.key)) return true;
  if (candidate.value && hasYamlComments(candidate.value)) return true;
  return candidate.items?.some(hasYamlComments) ?? false;
}

function hasYamlAnchorOrAlias(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if (isAlias(node)) return true;
  const candidate = node as {
    readonly anchor?: unknown;
    readonly key?: unknown;
    readonly value?: unknown;
    readonly items?: readonly unknown[];
  };
  if (candidate.anchor !== undefined) return true;
  if (candidate.key && hasYamlAnchorOrAlias(candidate.key)) return true;
  if (candidate.value && hasYamlAnchorOrAlias(candidate.value)) return true;
  return candidate.items?.some(hasYamlAnchorOrAlias) ?? false;
}

function hasExplicitYamlTag(node: unknown): boolean {
  return !!node && typeof node === 'object' && (node as { readonly tag?: unknown }).tag !== undefined;
}

function lineStart(source: string, offset: number): number {
  return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function removeLineBreakBefore(source: string): string | null {
  if (source.endsWith('\r\n')) return source.slice(0, -2);
  if (source.endsWith('\n')) return source.slice(0, -1);
  return null;
}

function consumeStyleLineTerminator(source: string): { suffix: string; consumedTerminator: boolean } {
  const linePadding = /^[ \t]*/.exec(source)?.[0] ?? '';
  const rest = source.slice(linePadding.length);
  const lineTerminator = /^(?:\r\n|\n)/.exec(rest);
  return lineTerminator
    ? { suffix: rest.slice(lineTerminator[0].length), consumedTerminator: true }
    : { suffix: rest, consumedTerminator: false };
}

function encodeStyleScalar(value: NoteStyle[keyof NoteStyle]): string {
  return stringify(value, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' }).trim();
}

function lineEndAfter(source: string, offset: number): number {
  if (source[offset - 1] === '\n') return offset;
  const newline = source.indexOf('\n', offset);
  return newline < 0 ? source.length : newline + 1;
}

function leadingIndent(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart, offset))?.[0] ?? '';
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function restoreUnchangedScalarLines(
  source: string,
  rendered: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changedCheckboxKeys: readonly string[],
  preserveRawKeys: ReadonlySet<string>,
): string {
  try {
    const original = parseDocument(source, { uniqueKeys: false });
    const output = parseDocument(rendered, { uniqueKeys: false });
    if (
      !isMap(original.contents) ||
      original.contents.flow ||
      !isMap(output.contents) ||
      output.contents.flow
    )
      return rendered;

    const candidates = new Map<string, string>();
    const originalCounts = new Map<string, number>();
    for (const item of original.contents.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') continue;
      const key = item.key.value;
      if (!preserveRawKeys.has(key)) continue;
      if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key) || !same(before[key], after[key]))
        continue;
      if (changedCheckboxKeys.some((name) => name.toLowerCase() === key.toLowerCase())) continue;
      if (!isScalar(item.value) || !item.key.range || !item.value.range) continue;
      const keyLine = lineBounds(source, item.key.range[0]);
      const valueLine = lineBounds(source, item.value.range[0]);
      if (keyLine.start !== valueLine.start || keyLine.end !== valueLine.end) continue;
      originalCounts.set(key, (originalCounts.get(key) ?? 0) + 1);
      candidates.set(key, keyLine.line);
    }

    const outputPairs = new Map<string, { count: number; start: number; end: number }>();
    for (const item of output.contents.items) {
      if (!isPair(item) || !isScalar(item.key) || typeof item.key.value !== 'string') continue;
      const key = item.key.value;
      if (!candidates.has(key) || !isScalar(item.value) || !item.key.range || !item.value.range) continue;
      const keyLine = lineBounds(rendered, item.key.range[0]);
      const valueLine = lineBounds(rendered, item.value.range[0]);
      if (keyLine.start !== valueLine.start || keyLine.end !== valueLine.end) continue;
      const current = outputPairs.get(key);
      outputPairs.set(key, { count: (current?.count ?? 0) + 1, start: keyLine.start, end: keyLine.end });
    }

    const replacements: Array<{ start: number; end: number; line: string }> = [];
    for (const [key, line] of candidates) {
      const target = outputPairs.get(key);
      if (originalCounts.get(key) !== 1 || target?.count !== 1) continue;
      if (rendered.slice(target.start, target.end) !== line) replacements.push({ ...target, line });
    }
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      rendered = `${rendered.slice(0, replacement.start)}${replacement.line}${rendered.slice(replacement.end)}`;
    }
    return rendered;
  } catch {
    return rendered;
  }
}

function lineBounds(source: string, offset: number): { start: number; end: number; line: string } {
  const start = source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  const newline = source.indexOf('\n', offset);
  let end = newline < 0 ? source.length : newline;
  if (end > start && source[end - 1] === '\r') end -= 1;
  return { start, end, line: source.slice(start, end) };
}

// tags may be a list, a single string or a comma separated string, with or without the leading #
export function readTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  const tags = raw
    .filter((tag): tag is string | number => typeof tag === 'string' || typeof tag === 'number')
    .map((tag) => normalizeTag(String(tag)))
    .filter((tag): tag is string => tag !== null);
  return [...new Set(tags)];
}

const TAG = /^[\p{L}\p{N}_\-/]+$/u;

export function normalizeTag(tag: string): string | null {
  const cleaned = tag.trim().replace(/^#/, '');
  if (!cleaned || cleaned.length > 100 || !TAG.test(cleaned) || /^\d+$/.test(cleaned)) return null;
  return cleaned;
}
