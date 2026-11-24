export interface ToggleHtmlAttribute {
  name: string;
  value: string | null;
}

export interface ToggleHtmlTag {
  name: string;
  start: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
  attributes: ToggleHtmlAttribute[];
  malformed: boolean;
}

export interface ToggleSummaryHeader {
  details: ToggleHtmlTag;
  summary: ToggleHtmlTag;
  summaryClose: ToggleHtmlTag;
  contentStart: number;
  contentEnd: number;
  level: 1 | 2 | 3 | 4 | 5 | 6 | null;
  titleStart: number;
  titleEnd: number;
  open: boolean;
  backgroundColor: string | null;
  summaryFormat: 'markdown' | null;
  supported: boolean;
}

export interface ToggleMarkupInspection {
  detailsTags: ToggleHtmlTag[];
  detailsCloseTags: ToggleHtmlTag[];
  summaryTags: ToggleHtmlTag[];
  headers: ToggleSummaryHeader[];
  unterminatedOpaqueStarts: number[];
}

export type DetailsStructureEvent =
  | { kind: 'open'; tag: ToggleHtmlTag }
  | { kind: 'close'; start: number; end: number };

export type DetailsHtmlBlockClassification =
  | { kind: 'raw'; events: [] }
  | { kind: 'open'; tag: ToggleHtmlTag; close: { start: number; end: number } | null; events: DetailsStructureEvent[] }
  | { kind: 'close'; close: { start: number; end: number }; events: DetailsStructureEvent[] };

const RAW_TEXT_ELEMENTS = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

export function isSupportedDetailsTag(tag: ToggleHtmlTag): boolean {
  return tag.name === 'details' && !tag.closing && readDetailsAttributes(tag).supported;
}

export function isSupportedSummaryTag(tag: ToggleHtmlTag): boolean {
  return tag.name === 'summary' && !tag.closing && readSummaryAttributes(tag).supported;
}

export function toggleExtensionAttributeNames(tag: ToggleHtmlTag): string[] {
  return tag.name === 'summary'
    ? tag.attributes
        .filter((attribute) => attribute.name === 'data-block-background' || attribute.name === 'data-morrow-summary-format')
        .map((attribute) => attribute.name)
    : [];
}

/** Reads only direct details/summary headers and skips tag-like text in inline code. */
export function inspectToggleMarkup(source: string): ToggleMarkupInspection {
  const tags = scanTags(source);
  const detailsTags = tags.filter((tag) => tag.name === 'details' && !tag.closing);
  const detailsCloseTags = tags.filter((tag) => tag.name === 'details' && tag.closing);
  const summaryTags = tags.filter((tag) => tag.name === 'summary' && !tag.closing);
  const headers: ToggleSummaryHeader[] = [];

  for (const details of detailsTags) {
    const summary = tags.find(
      (tag) =>
        tag.start >= details.end &&
        source.slice(details.end, tag.start).trim() === '' &&
        tag.name !== 'code',
    );
    if (!summary || summary.name !== 'summary' || summary.closing || summary.malformed) continue;

    const closingSummary = tags.find(
      (tag) => tag.start >= summary.end && tag.name === 'summary' && tag.closing,
    );
    if (!closingSummary) continue;
    const nestedStructure = tags.some(
      (tag) =>
        tag.start >= summary.end &&
        tag.start < closingSummary.start &&
        ((tag.name === 'summary' && !tag.closing) || tag.name === 'details'),
    );
    if (nestedStructure) continue;

    const detailsAttrs = readDetailsAttributes(details);
    const summaryAttrs = readSummaryAttributes(summary);
    const heading = readHeading(source, summary.end, closingSummary.start, tags);
    headers.push({
      details,
      summary,
      summaryClose: closingSummary,
      contentStart: summary.end,
      contentEnd: closingSummary.start,
      level: heading?.level ?? null,
      titleStart: heading?.contentStart ?? summary.end,
      titleEnd: heading?.contentEnd ?? closingSummary.start,
      open: detailsAttrs.open,
      backgroundColor: summaryAttrs.backgroundColor,
      summaryFormat: summaryAttrs.summaryFormat,
      supported: detailsAttrs.supported && summaryAttrs.supported,
    });
  }

  const unterminatedOpaqueStarts = tags
    .filter(
      (tag) =>
        tag.malformed &&
        (RAW_TEXT_ELEMENTS.has(tag.name) || tag.name === 'plaintext' || tag.name === 'comment'),
    )
    .map((tag) => tag.start);
  return { detailsTags, detailsCloseTags, summaryTags, headers, unterminatedOpaqueStarts };
}

function readHeading(
  source: string,
  contentStart: number,
  contentEnd: number,
  tags: ToggleHtmlTag[],
): { level: 1 | 2 | 3 | 4 | 5 | 6; contentStart: number; contentEnd: number } | null {
  const heading = tags.find(
    (tag) =>
      tag.start >= contentStart &&
      tag.start < contentEnd &&
      source.slice(contentStart, tag.start).trim() === '' &&
      /^h[1-6]$/.test(tag.name) &&
      !tag.closing &&
      !tag.malformed,
  );
  // Heading attributes are not represented by detailsSummary. Keep these pairs out of
  // the codec rather than silently dropping IDs/classes while rewriting the page.
  if (!heading || heading.attributes.length > 0) return null;
  const close = tags.find(
    (tag) => tag.start >= heading.end && tag.start < contentEnd && tag.name === heading.name && tag.closing,
  );
  if (!close || source.slice(close.end, contentEnd).trim() !== '') return null;
  const level = Number(heading.name.slice(1));
  return {
    level: level as 1 | 2 | 3 | 4 | 5 | 6,
    contentStart: heading.end,
    contentEnd: close.start,
  };
}

/** Reads a single complete direct summary after a details opening tag at the start of a block. */
export function readToggleSummaryHeader(source: string): ToggleSummaryHeader | null {
  const tags = scanTags(source);
  const details = tags.find((tag) => tag.name === 'details' && !tag.closing && source.slice(0, tag.start).trim() === '');
  if (!details) return null;
  const header = inspectToggleMarkup(source).headers.find((candidate) => candidate.details.start === details.start);
  return header ?? null;
}

/**
 * Shares the parser's HTML-block boundary decision with the compatibility guard.
 * A details owner can close in its body, or a block may open only when its first tag
 * is a real, non-self-closing details tag. Details-like tags inside other HTML blocks
 * remain opaque raw source.
 */
export function classifyDetailsHtmlBlock(
  source: string,
  insideDetailsContent: boolean,
): DetailsHtmlBlockClassification {
  if (insideDetailsContent) {
    const close = matchingDetailsClose(source);
    if (close) return { kind: 'close', close, events: [{ kind: 'close', ...close }] };
  }

  const leading = /^\s*/.exec(source)?.[0].length ?? 0;
  const opening = readTag(source, leading);
  if (!opening || opening.name !== 'details' || opening.closing || opening.selfClosing) {
    return { kind: 'raw', events: [] };
  }

  const relativeClose = matchingDetailsClose(source.slice(opening.end));
  const close = relativeClose
    ? { start: opening.end + relativeClose.start, end: opening.end + relativeClose.end }
    : null;
  const events: DetailsStructureEvent[] = [{ kind: 'open', tag: opening }];
  if (close) events.push({ kind: 'close', ...close });
  return { kind: 'open', tag: opening, close, events };
}

/** Finds the matching details close after a summary, ignoring tag-like text in inline code. */
export function matchingDetailsClose(source: string): { start: number; end: number } | null {
  const tags = scanTags(source);
  let depth = 1;
  for (const tag of tags) {
    if (tag.name !== 'details') continue;
    if (tag.closing) depth--;
    else if (!tag.selfClosing) depth++;
    if (depth === 0) return { start: tag.start, end: tag.end };
  }
  return null;
}

/** True when the direct details block has non-whitespace source after its matching close tag. */
export function hasToggleSuffixAfterDetailsClose(source: string): boolean {
  const close = matchingDetailsClose(source);
  return close !== null && source.slice(close.end).trim().length > 0;
}

/** True when an HTML block begins with a details close and appends another HTML/text fragment. */
export function hasDetailsCloseSuffix(source: string): boolean {
  const leading = /^\s*/.exec(source)?.[0].length ?? 0;
  const close = /^<\/details\s*>/i.exec(source.slice(leading));
  if (!close) return false;
  return source.slice(leading + close[0].length).trim().length > 0;
}

function readDetailsAttributes(tag: ToggleHtmlTag): { open: boolean; supported: boolean } {
  const seen = new Set<string>();
  let open = false;
  let supported = !tag.malformed && !tag.selfClosing;
  for (const attribute of tag.attributes) {
    if (seen.has(attribute.name)) supported = false;
    seen.add(attribute.name);
    if (attribute.name !== 'open') {
      supported = false;
      continue;
    }
    open = true;
  }
  return { open, supported };
}

function readSummaryAttributes(tag: ToggleHtmlTag): {
  backgroundColor: string | null;
  summaryFormat: 'markdown' | null;
  supported: boolean;
} {
  const seen = new Set<string>();
  let backgroundColor: string | null = null;
  let summaryFormat: 'markdown' | null = null;
  let supported = !tag.malformed && !tag.selfClosing;
  for (const attribute of tag.attributes) {
    if (seen.has(attribute.name)) supported = false;
    seen.add(attribute.name);
    if (attribute.name === 'data-block-background') {
      if (typeof attribute.value !== 'string' || !/^#[\da-f]{6}$/i.test(attribute.value)) {
        supported = false;
      } else {
        backgroundColor = attribute.value.toLowerCase();
      }
    } else if (attribute.name === 'data-morrow-summary-format') {
      if (attribute.value !== 'markdown') supported = false;
      else summaryFormat = 'markdown';
    } else {
      supported = false;
    }
  }
  return { backgroundColor, summaryFormat, supported };
}

function scanTags(source: string): ToggleHtmlTag[] {
  const tags: ToggleHtmlTag[] = [];
  let position = 0;
  let inSummaryTitle = false;
  while (position < source.length) {
    if (source[position] === '`') {
      const codeEnd = skipMarkdownCodeSpan(source, position);
      if (codeEnd !== null) {
        position = codeEnd;
        continue;
      }
    }
    // Summary contents are Markdown inline source, so an escaped `<` is literal text
    // there. Elsewhere the source is raw HTML: a backslash before a close tag is body
    // text and must not hide the structural `</details>` delimiter.
    if (inSummaryTitle && source[position] === '<' && isMarkdownEscaped(source, position)) {
      position++;
      continue;
    }
    if (source.startsWith('<!--', position)) {
      const end = source.indexOf('-->', position + 4);
      if (end < 0) {
        tags.push({
          name: 'comment',
          start: position,
          end: source.length,
          closing: false,
          selfClosing: false,
          attributes: [],
          malformed: true,
        });
      }
      position = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[position] !== '<') {
      position++;
      continue;
    }

    const tag = readTag(source, position);
    if (!tag) {
      position++;
      continue;
    }
    if (!tag.closing && tag.name === 'code') {
      const close = /<\/code\s*>/ig;
      close.lastIndex = tag.end;
      const match = close.exec(source);
      if (match) {
        position = close.lastIndex;
        continue;
      }
      tags.push({ ...tag, malformed: true });
      position = tag.end;
      continue;
    }
    if (!tag.closing && tag.name === 'plaintext') {
      // HTML plaintext consumes the rest of its input; apparent closing tags after it
      // cannot safely be treated as structure by this scanner.
      tags.push({ ...tag, malformed: true });
      position = source.length;
      continue;
    }
    if (!tag.closing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'ig');
      close.lastIndex = tag.end;
      const match = close.exec(source);
      // An unmatched raw-text element is opaque through EOF, so it cannot contribute
      // a fake summary/details close.
      if (!match) tags.push({ ...tag, malformed: true });
      position = match ? close.lastIndex : source.length;
      continue;
    }
    tags.push(tag);
    if (tag.name === 'summary') inSummaryTitle = !tag.closing;
    position = tag.end;
  }
  return tags;
}

function isMarkdownEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function skipMarkdownCodeSpan(source: string, start: number): number | null {
  let slashes = 0;
  for (let index = start - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  if (slashes % 2 === 1) return null;
  let runEnd = start + 1;
  while (source[runEnd] === '`') runEnd++;
  const runLength = runEnd - start;
  let cursor = runEnd;
  while (cursor < source.length) {
    const next = source.indexOf('`', cursor);
    if (next < 0) return null;
    let nextEnd = next + 1;
    while (source[nextEnd] === '`') nextEnd++;
    if (nextEnd - next === runLength) return nextEnd;
    cursor = nextEnd;
  }
  return null;
}

function readTag(source: string, start: number): ToggleHtmlTag | null {
  const startTag = /^<([a-z][a-z\d:-]*)\b/i.exec(source.slice(start));
  const closeTag = /^<\/([a-z][a-z\d:-]*)\s*>/i.exec(source.slice(start));
  if (closeTag) {
    return {
      name: closeTag[1]!.toLowerCase(),
      start,
      end: start + closeTag[0].length,
      closing: true,
      selfClosing: false,
      attributes: [],
      malformed: false,
    };
  }
  if (!startTag) return null;

  const name = startTag[1]!.toLowerCase();
  let cursor = start + startTag[0].length;
  const attributes: ToggleHtmlAttribute[] = [];
  const malformed = false;
  while (cursor < source.length) {
    while (/[\t\n\r ]/.test(source[cursor] ?? '')) cursor++;
    if (source[cursor] === '>') {
      return {
        name,
        start,
        end: cursor + 1,
        closing: false,
        selfClosing: false,
        attributes,
        malformed,
      };
    }
    if (source[cursor] === '/' && source[cursor + 1] === '>') {
      return {
        name,
        start,
        end: cursor + 2,
        closing: false,
        selfClosing: true,
        attributes,
        malformed,
      };
    }
    const attr = /^[^\t\n\r />="']+/.exec(source.slice(cursor));
    if (!attr) return null;
    const attributeName = attr[0].toLowerCase();
    cursor += attr[0].length;
    while (/[\t\n\r ]/.test(source[cursor] ?? '')) cursor++;
    let value: string | null = null;
    if (source[cursor] === '=') {
      cursor++;
      while (/[\t\n\r ]/.test(source[cursor] ?? '')) cursor++;
      const quote = source[cursor];
      if (quote === '"' || quote === "'") {
        cursor++;
        const end = source.indexOf(quote, cursor);
        if (end < 0) return null;
        value = source.slice(cursor, end);
        cursor = end + 1;
      } else {
        const unquoted = /^[^\t\n\r >]+/.exec(source.slice(cursor));
        if (!unquoted) return null;
        value = unquoted[0];
        cursor += unquoted[0].length;
      }
    }
    attributes.push({ name: attributeName, value });
  }
  return null;
}
