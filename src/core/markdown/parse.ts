import MarkdownIt from 'markdown-it';
import type { StateBlock, StateInline, Token } from 'markdown-it';
import { BACKGROUND_HEX, calloutTone, COLORS, emptyDoc, parseInlineColor, TEXT_HEX } from '../model';
import type { DocMark, DocNode, PageId } from '../model';
import { inlineText } from '../doc';
import type { InlineColor } from '../model';
import { decodePolarisDadosViewMarker } from '../polarisDadosView';
import { parseBlockBackgroundMarker, supportsHexBlockBackgroundOwner } from './blockBackground';
import { scanMarkdownDestination } from './markdownLinkDestination';
import {
  ALIGN_PATTERN,
  BACKGROUND_PATTERN,
  EMBED_TITLE_COMMENT,
  PREVIEW_COMMENT,
  calloutIcon,
  LETTERS_COMMENT,
  HEADER_COLUMN,
  imageWidth,
  toggleLevel,
} from './serialize';
import { COLUMN_WIDTHS_PATTERN } from './serialize';

export interface ParseOptions {
  // resolves a [[wiki link]] target, a title or a path inside the vault, to a page id
  resolvePage?: (target: string) => PageId | null;
  // resolves relative links such as notion exports use between pages
  resolveLink?: (href: string) => PageId | null;
  // resolves an inline Markdown link only when its exact page file path is unique
  resolveMarkdownPageLink?: (markdownHref: string) => PageId | null;
  // resolves image and file paths, and ![[embeds]], to stored files
  resolveFile?: (href: string) => { fileId: string; name: string; image: boolean } | null;
  // links to pages that do not exist yet stay live and create the page when followed, on by default
  keepUnresolved?: boolean;
  /** @internal Nested HTML wrappers disable marker interpretation until their format is supported. */
  allowLegacyBlockBackgrounds?: boolean;
}

export interface WikiLink {
  target: string;
  anchor: string | null;
  alias: string | null;
  embed: boolean;
}

export interface BlockBackgroundMarkerInspection {
  comment: string;
  color: InlineColor | null;
  tokenIndex: number;
  tokenType: string;
  approved: boolean;
  targetType: string | null;
  targetTag: string | null;
  titleHeading: boolean;
}

interface ParsedMarkdownDoc {
  doc: DocNode;
  blockBackgroundMarkers: BlockBackgroundMarkerInspection[];
}

const BLOCK_BACKGROUND_MARKER_IDS = Symbol('morrow.blockBackgroundMarkerIds');
type MarkerOwnedDocNode = DocNode & { [BLOCK_BACKGROUND_MARKER_IDS]?: number[] };

const md = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);
md.inline.ruler.before('link', 'wikilink', wikiLinkRule);
md.inline.ruler.after('backticks', 'math_inline', mathInlineRule);
md.inline.ruler.after('strikethrough', 'highlight', highlightRule);
md.block.ruler.before('fence', 'math_block', mathBlockRule, {
  alt: ['paragraph', 'reference', 'blockquote', 'list'],
});

// The installed table rule intentionally unescapes `\\|` while splitting cells. Preserve the
// source offsets only for retarget scans so edits can map token ranges back through that change.
const tableRuleDefinition = md.block.ruler.__rules__.find((rule) => rule.name === 'table');
const markdownTableRule = tableRuleDefinition?.fn as
  ((state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean) | undefined;
if (!tableRuleDefinition || !markdownTableRule) throw new Error('markdown-it table rule is unavailable');
md.block.ruler.at(
  'table',
  (state, startLine, endLine, silent) => {
    const tokenStart = state.tokens.length;
    const matched = markdownTableRule(state, startLine, endLine, silent);
    if (matched && !silent && state.env?.morrowRetargetSourceMaps === true)
      attachTableCellSourceMaps(state, state.tokens.slice(tokenStart));
    return matched;
  },
  { alt: tableRuleDefinition.alt },
);

// markdown-it normalizes link destinations before exposing them on tokens. Wrap the built-in rule so
// inline note links can keep the source spelling without reimplementing CommonMark link parsing.
const linkRuleDefinition = md.inline.ruler.__rules__.find((rule) => rule.name === 'link');
const markdownLinkRule = linkRuleDefinition?.fn as
  ((state: StateInline, silent: boolean) => boolean) | undefined;
if (!linkRuleDefinition || !markdownLinkRule) throw new Error('markdown-it inline link rule is unavailable');
md.inline.ruler.at(
  'link',
  (state, silent) => {
    const linkStart = state.pos;
    const labelEnd =
      state.src.charCodeAt(linkStart) === 0x5b ? state.md.helpers.parseLinkLabel(state, linkStart, true) : -1;
    const tokenStart = state.tokens.length;
    const matched = markdownLinkRule(state, silent);
    if (matched && !silent && labelEnd >= 0 && state.src.charCodeAt(labelEnd + 1) === 0x28) {
      const linkToken = state.tokens.slice(tokenStart).find((token) => token.type === 'link_open');
      if (linkToken) {
        const meta: Record<string, unknown> = { ...(linkToken.meta ?? {}), morrowMarkdownHrefScanned: true };
        const destination = scanMarkdownDestination(state.src, labelEnd + 1, 16_384);
        if (destination && destination.close === state.pos - 1) {
          meta.markdownHref = state.src.slice(destination.start, destination.end);
          meta.morrowMarkdownHrefRange = { start: destination.start, end: destination.end };
        }
        linkToken.meta = meta;
      }
    }
    return matched;
  },
  { alt: linkRuleDefinition.alt },
);

const MAX_INPUT = 5_000_000;
// a checkbox is [ ] or [x], and notion's exports also write an empty box as [] or with a non-breaking space
const TASK_PREFIX = /^\[([ \u00a0xX]?)\](?:\s+|$)/;
// obsidian callouts and github alerts: > [!type]+ optional title
const CALLOUT = /^\[!([A-Za-z][\w-]{0,30})(?:\|([^\]\n]{0,80}))?\]([+-]?)[ \t]*/;
const WIKI = /^(!?)\[\[([^[\]\n]{0,400}?)\]\]/;

interface TableCellSourceMap {
  normalizedStart: number;
  removedBefore: ArrayLike<number>;
}

interface EscapedTableCell {
  content: string;
  normalizedStart: number;
  removedBefore: number[];
}

function attachTableCellSourceMaps(state: StateBlock, tokens: Token[]): void {
  let inTable = false;
  let rowLine: number | null = null;
  let cellIndex = 0;
  const rows = new Map<number, EscapedTableCell[] | null>();
  for (const token of tokens) {
    if (token.type === 'table_open') inTable = true;
    else if (token.type === 'table_close') {
      inTable = false;
      rowLine = null;
    } else if (inTable && token.type === 'tr_open') {
      rowLine = Array.isArray(token.map) ? token.map[0]! : null;
      cellIndex = 0;
    } else if (inTable && token.type === 'tr_close') {
      rowLine = null;
    } else if (inTable && rowLine !== null && token.type === 'inline') {
      let cells = rows.get(rowLine);
      if (cells === undefined) {
        cells = tableCellsAtSourceLine(state, rowLine);
        rows.set(rowLine, cells);
      }
      const cell = cells?.[cellIndex];
      if (cell && cell.content === token.content) {
        token.meta = {
          ...(token.meta ?? {}),
          morrowTableCellSourceMap: {
            normalizedStart: cell.normalizedStart,
            removedBefore: cell.removedBefore.length ? Uint32Array.from(cell.removedBefore) : [],
          } satisfies TableCellSourceMap,
        };
      }
      cellIndex++;
    }
  }
}

function tableCellsAtSourceLine(state: StateBlock, line: number): EscapedTableCell[] | null {
  const lineStart = state.bMarks[line]! + state.tShift[line]!;
  const lineEnd = state.eMarks[line]!;
  if (lineStart < 0 || lineEnd < lineStart || lineEnd > state.src.length) return null;
  const sourceLine = state.src.slice(lineStart, lineEnd);
  const leadingWhitespace = sourceLine.length - sourceLine.trimStart().length;
  const tableLine = sourceLine.trim();
  const cells = splitEscapedTableCells(tableLine);
  if (cells.length && cells[0]!.content === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.content === '') cells.pop();

  const tableLineStart = lineStart + leadingWhitespace;
  return cells.map((cell) => {
    const leading = cell.content.length - cell.content.trimStart().length;
    const content = cell.content.trim();
    const removedBeforeLeading = cell.removedBefore.filter((offset) => offset < leading).length;
    const removedBefore = cell.removedBefore
      .filter((offset) => offset >= leading && offset < leading + content.length)
      .map((offset) => offset - leading);
    return {
      content,
      normalizedStart: tableLineStart + cell.segmentStart + leading + removedBeforeLeading,
      removedBefore,
    };
  });
}

function splitEscapedTableCells(line: string): Array<{
  content: string;
  segmentStart: number;
  removedBefore: number[];
}> {
  const cells: Array<{ content: string; segmentStart: number; removedBefore: number[] }> = [];
  const decoded = new Uint16Array(line.length);
  let segmentStart = 0;
  let cellOutputStart = 0;
  let outputLength = 0;
  let removedBefore: number[] = [];
  let isEscaped = false;
  for (let position = 0; position < line.length; position++) {
    const char = line[position]!;
    if (char === '|') {
      if (isEscaped) {
        outputLength--;
        removedBefore.push(outputLength - cellOutputStart);
        decoded[outputLength++] = 0x7c;
      } else {
        cells.push({
          content: utf16BufferSlice(decoded, cellOutputStart, outputLength),
          segmentStart,
          removedBefore,
        });
        segmentStart = position + 1;
        cellOutputStart = outputLength;
        removedBefore = [];
      }
    } else {
      decoded[outputLength++] = line.charCodeAt(position);
    }
    isEscaped = char === '\\';
  }
  cells.push({
    content: utf16BufferSlice(decoded, cellOutputStart, outputLength),
    segmentStart,
    removedBefore,
  });
  return cells;
}

function utf16BufferSlice(buffer: Uint16Array, start: number, end: number): string {
  const parts: string[] = [];
  for (let index = start; index < end; index += 8192)
    parts.push(String.fromCharCode(...buffer.subarray(index, Math.min(end, index + 8192))));
  return parts.join('');
}

function unescapeTablePipes(text: string): string {
  const chars: string[] = [];
  let isEscaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '|' && isEscaped) chars.pop();
    chars.push(char);
    isEscaped = char === '\\';
  }
  return chars.join('');
}

// [[target#anchor|alias]] and ![[embed]], before markdown links so the brackets are not read as one
function wikiLinkRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const first = state.src.charCodeAt(start);
  if (first !== 0x21 && first !== 0x5b) return false;
  const match = WIKI.exec(state.src.slice(start, Math.min(state.posMax, start + 810)));
  if (!match) return false;
  if (!silent) {
    const wiki = parseWikiLink(match[2]!, match[1] === '!');
    const inner = match[2]!;
    const aliasStart = inner.search(/\\?\|/);
    const path = (aliasStart === -1 ? inner : inner.slice(0, aliasStart)).split('#', 1)[0]!;
    const targetStartInPath = path.length - path.trimStart().length;
    const targetStart = start + (match[1]?.length ?? 0) + 2 + targetStartInPath;
    const token = state.push('wikilink', '', 0);
    token.meta = {
      ...wiki,
      morrowRetargetRange: { start, end: start + match[0].length },
      morrowRetargetTargetRange: { start: targetStart, end: targetStart + wiki.target.length },
    };
    token.markup = match[0];
  }
  state.pos += match[0].length;
  return true;
}

export function parseWikiLink(inner: string, embed: boolean): WikiLink {
  // tables escape the alias bar as \|
  const bar = inner.search(/\\?\|/);
  const head = bar === -1 ? inner : inner.slice(0, bar);
  const alias = bar === -1 ? null : inner.slice(bar).replace(/^\\?\|/, '');
  const hash = head.indexOf('#');
  return {
    target: (hash === -1 ? head : head.slice(0, hash)).trim(),
    anchor: hash === -1 ? null : head.slice(hash + 1).trim(),
    alias: alias === null ? null : alias.trim(),
    embed,
  };
}

// $inline$ with the usual rules that keep prices like $5 and $10 as text
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24) return false;
  const display = src.charCodeAt(start + 1) === 0x24;
  const open = display ? 2 : 1;
  const next = src[start + open];
  if (!next || /\s/.test(next) || next === '$') return false;
  const closer = display ? '$$' : '$';
  let end = src.indexOf(closer, start + open);
  while (end !== -1 && src[end - 1] === '\\') end = src.indexOf(closer, end + 1);
  if (end === -1 || end + open > state.posMax) return false;
  const content = src.slice(start + open, end);
  if (/\s$/.test(content) || content.includes('\n\n')) return false;
  if (!display && /\d/.test(src[end + 1] ?? '')) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = content;
    token.markup = closer;
  }
  state.pos = end + open;
  return true;
}

// ==highlighted text== as obsidian writes it
function highlightRule(state: StateInline, silent: boolean): boolean {
  const { src } = state;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  if (src.charCodeAt(start + 2) === 0x3d) return false;
  const end = src.indexOf('==', start + 2);
  if (end === -1 || end + 2 > state.posMax || end === start + 2) return false;
  const inner = src.slice(start + 2, end);
  if (/^\s|\s$/.test(inner) || inner.includes('\n\n')) return false;
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    const max = state.posMax;
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

// $$ on its own line opens a display formula that runs until a line ending in $$
function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  if (!state.src.startsWith('$$', start)) return false;
  const firstRest = state.src.slice(start + 2, max).trim();
  let line = startLine;
  const parts: string[] = [];
  if (firstRest.endsWith('$$') && firstRest.length >= 2) {
    parts.push(firstRest.slice(0, -2));
  } else {
    if (firstRest) parts.push(firstRest);
    let closed = false;
    while (++line < endLine) {
      const from = state.bMarks[line]! + state.tShift[line]!;
      const to = state.eMarks[line]!;
      if (from < to && state.sCount[line]! < state.blkIndent) break;
      const text = state.src.slice(from, to);
      if (text.trimEnd().endsWith('$$')) {
        const before = text.trimEnd().slice(0, -2);
        if (before.trim()) parts.push(before);
        closed = true;
        break;
      }
      parts.push(state.src.slice(state.bMarks[line]!, to));
    }
    if (!closed) return false;
  }
  if (silent) return true;
  state.line = line + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = parts.join('\n').trim();
  token.map = [startLine, state.line];
  return true;
}

// obsidian's block id: " ^id" at the end of a paragraph, kept on the paragraph rather than in its text
const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]{1,64})[ \t]*$/;

// a paragraph of nothing but <br> is an empty line someone left on purpose, the way morrow writes one
function emptyLine(paragraph: DocNode): void {
  if (paragraph.content?.length === 1 && paragraph.content[0]!.type === 'hardBreak') paragraph.content = [];
}

function takeBlockId(paragraph: DocNode): void {
  const last = paragraph.content?.[paragraph.content.length - 1];
  if (paragraph.type !== 'paragraph' || last?.type !== 'text' || !last.text) return;
  const match = BLOCK_ID.exec(last.text);
  // a paragraph that is only an id belongs to the block before it in obsidian, so it stays as text
  if (!match || (!last.text.slice(0, match.index).trim() && paragraph.content!.length === 1)) return;
  const rest = last.text.slice(0, match.index);
  if (rest) last.text = rest;
  else paragraph.content!.pop();
  paragraph.attrs = { ...paragraph.attrs, blockId: match[1] };
}

export function markdownToDoc(source: string, options: ParseOptions = {}): DocNode {
  return parseMarkdownToDoc(source, options).doc;
}

function parseMarkdownToDoc(source: string, options: ParseOptions = {}): ParsedMarkdownDoc {
  const text = source.length > MAX_INPUT ? source.slice(0, MAX_INPUT) : source;
  const tokens = md.parse(text.replace(/\r\n?/g, '\n'), {});
  const hasBlockBackground = /<!--[ \t\r\n]*morrow:block-background(?=[\s:>])/i.test(text);
  const backgroundMarkers = hasBlockBackground ? inspectBlockBackgroundMarkerTokens(tokens) : [];
  const approvedBackgroundMarkers = new Map(
    (options.allowLegacyBlockBackgrounds === false ? [] : backgroundMarkers)
      .filter((marker) => marker.approved && marker.color)
      .map((marker) => [marker.tokenIndex, marker.color!] as const),
  );
  const root: DocNode = { type: 'doc', content: [] };
  const stack: DocNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  // what a comment morrow writes above a block says about it: its background colour, or a list counted in
  // letters. it goes on the next block at the same level
  let pending: { attrs: Record<string, unknown>; parent: DocNode; markerIds: number[] } | null = null;
  const note = (attrs: Record<string, unknown>, blockBackgroundMarkerId?: number) => {
    const previous = pending;
    const sameParent = previous?.parent === top();
    pending = {
      attrs: { ...(sameParent ? previous.attrs : {}), ...attrs },
      parent: top(),
      markerIds: [
        ...(sameParent ? previous.markerIds : []),
        ...(blockBackgroundMarkerId === undefined ? [] : [blockBackgroundMarkerId]),
      ],
    };
  };
  const push = (node: DocNode) => {
    if (pending?.parent === top()) {
      const { type, ...rest } = pending.attrs;
      node.attrs = { ...node.attrs, ...rest, ...(type && node.type === 'orderedList' ? { type } : {}) };
      if (pending.markerIds.length)
        (node as MarkerOwnedDocNode)[BLOCK_BACKGROUND_MARKER_IDS] = pending.markerIds;
    }
    pending = null;
    (top().content ??= []).push(node);
  };
  const open = (node: DocNode) => {
    push(node);
    stack.push(node);
  };
  const close = () => {
    if (stack.length > 1) stack.pop();
  };
  // set by the comment morrow writes above a table whose first column is a header
  let headerColumn = false;
  let tableHasHeaderColumn = false;
  // the widths from a comment above a table, for its cells
  let columnWidths: number[] = [];
  let tableWidths: number[] = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]!;
    if (token.type !== 'table_open' && token.type !== 'html_block') {
      headerColumn = false;
      columnWidths = [];
    }
    switch (token.type) {
      case 'paragraph_open':
        open({ type: 'paragraph', content: [] });
        break;
      case 'heading_open':
        open({ type: 'heading', attrs: { level: Number(token.tag.slice(1)) || 1 }, content: [] });
        break;
      case 'blockquote_open':
        open({ type: 'blockquote', content: [] });
        break;
      case 'bullet_list_open':
        open({ type: 'bulletList', content: [] });
        break;
      case 'ordered_list_open': {
        const start = Number(token.attrGet('start') ?? 1);
        open({ type: 'orderedList', attrs: { start: Number.isFinite(start) ? start : 1 }, content: [] });
        break;
      }
      case 'list_item_open':
        open({ type: 'listItem', content: [] });
        break;
      case 'table_open':
        tableHasHeaderColumn = headerColumn;
        headerColumn = false;
        tableWidths = columnWidths;
        columnWidths = [];
        open({ type: 'table', content: [] });
        break;
      case 'tr_open':
        open({ type: 'tableRow', content: [] });
        break;
      case 'th_open':
      case 'td_open': {
        const index = (top().content ?? []).length;
        const header = token.type === 'th_open' || (tableHasHeaderColumn && index === 0);
        const width = tableWidths[index] ?? 0;
        open({
          type: header ? 'tableHeader' : 'tableCell',
          ...(width > 0 ? { attrs: { colwidth: [width] } } : {}),
          content: [],
        });
        open({ type: 'paragraph', content: [] });
        break;
      }
      case 'th_close':
      case 'td_close':
        close();
        close();
        break;
      case 'paragraph_close':
        emptyLine(top());
        takeBlockId(top());
        close();
        break;
      case 'heading_close':
      case 'blockquote_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'table_close':
      case 'tr_close':
        close();
        break;
      case 'inline': {
        const cell = stack[stack.length - 2];
        // a list item with a background of its own ends its first line with the comment for it
        if (cell?.type === 'listItem' && (cell.content ?? []).length === 1) {
          const children = token.children ?? [];
          const last = children[children.length - 1];
          const color =
            last?.type === 'html_inline' ? BACKGROUND_PATTERN.exec(last.content.trim())?.[1] : null;
          if (color && (COLORS as readonly string[]).includes(color)) {
            cell.attrs = { ...cell.attrs, backgroundColor: color };
            children.pop();
            const before = children[children.length - 1];
            if (before?.type === 'text') before.content = before.content.replace(/\s+$/, '');
          }
        }
        if (cell && (cell.type === 'tableCell' || cell.type === 'tableHeader'))
          cellInline(token.children ?? [], options, cell, top());
        else (top().content ??= []).push(...inlineNodes(token.children ?? [], options));
        break;
      }
      case 'fence':
      case 'code_block': {
        const code = token.content.replace(/\n$/, '');
        const language = token.info.trim().split(/\s+/)[0] ?? '';
        push({
          type: 'codeBlock',
          attrs: { language: language || null },
          content: code ? [{ type: 'text', text: code }] : [],
        });
        break;
      }
      case 'math_block':
        push({ type: 'blockMath', attrs: { latex: token.content } });
        break;
      case 'hr':
        push({ type: 'horizontalRule' });
        break;
      case 'html_block':
        if (token.content.trim() === HEADER_COLUMN) {
          headerColumn = true;
          break;
        }
        {
          const background = approvedBackgroundMarkers.get(tokenIndex);
          if (background) {
            note({ backgroundColor: background }, tokenIndex);
            break;
          }
          const view = decodePolarisDadosViewMarker(token.content.trim());
          if (view && hasInvalidViewListStart(stack)) {
            push({ type: 'rawBlock', attrs: { text: token.content.replace(/\n+$/, '') } });
          } else if (view) push({ type: 'polarisDadosView', attrs: view });
          else if (
            hasInvalidViewListStart(stack) &&
            /<!--\s*morrow:polaris-dados-view\s*:/i.test(token.content)
          ) {
            // Keep nested or malformed protocol markers from becoming atoms after list normalization.
            push({ type: 'rawBlock', attrs: { text: token.content.replace(/\n+$/, '') } });
          } else {
            const widths = COLUMN_WIDTHS_PATTERN.exec(token.content.trim())?.[1];
            if (widths) {
              columnWidths = widths.split(/\s+/).map((width) => Math.min(2000, Number(width) || 0));
              break;
            }
            const color = BACKGROUND_PATTERN.exec(token.content.trim())?.[1];
            if (color && (COLORS as readonly string[]).includes(color)) {
              note({ backgroundColor: color });
              break;
            }
            const side = ALIGN_PATTERN.exec(token.content.trim())?.[1];
            if (side) {
              note({ align: side });
              break;
            }
            if (token.content.trim() === EMBED_TITLE_COMMENT) {
              note({ embedTitle: false });
              break;
            }
            if (token.content.trim() === PREVIEW_COMMENT) {
              note({ preview: true });
              break;
            }
            if (token.content.trim() === LETTERS_COMMENT) {
              note({ type: 'a' });
              break;
            }
            htmlBlock(token.content, options, { push, top, close, stack });
          }
        }
        break;
      default:
        break;
    }
  }

  const invalidMarkerIds = new Set<number>();
  const normalized = normalize(root, invalidMarkerIds);
  const provenBackgroundMarkers = backgroundMarkers.length
    ? proveBlockBackgroundOwners(normalized, backgroundMarkers, invalidMarkerIds)
    : backgroundMarkers;
  if (backgroundMarkers.length) removeBlockBackgroundMarkerIds(normalized, provenBackgroundMarkers);
  return {
    doc: (normalized.content ?? []).length > 0 ? normalized : emptyDoc(),
    blockBackgroundMarkers: provenBackgroundMarkers,
  };
}

function hasInvalidViewListStart(stack: DocNode[]): boolean {
  return stack.some((node) => {
    if (node.type !== 'listItem' && node.type !== 'taskItem') return false;
    const first = node.content?.[0];
    return first?.type !== 'paragraph';
  });
}

const CELL_LIST_OPEN = /^<(ul|ol)\b([^>]*)>$/i;
const CELL_LIST_CLOSE = /^<\/(ul|ol)\s*>$/i;
const CELL_ITEM_OPEN = /^<li\b([^>]*)>$/i;
const CELL_ITEM_CLOSE = /^<\/li\s*>$/i;

// a table cell is one line of markdown, lists in it are written as html tags, the way obsidian reads them
function cellInline(children: Token[], options: ParseOptions, cell: DocNode, first: DocNode): void {
  const containers: DocNode[] = [cell];
  let paragraph: DocNode | null = first;
  let run: Token[] = [];
  const container = () => containers[containers.length - 1]!;
  const flush = () => {
    if (!run.length) return;
    if (!paragraph) {
      paragraph = { type: 'paragraph', content: [] };
      (container().content ??= []).push(paragraph);
    }
    (paragraph.content ??= []).push(...inlineNodes(run, options));
    run = [];
  };
  const tag = (token: Token) => (token.type === 'html_inline' ? token.content.trim() : '');
  for (const token of children) {
    const html = tag(token);
    const list = CELL_LIST_OPEN.exec(html);
    const item = CELL_ITEM_OPEN.exec(html);
    if (list) {
      flush();
      const task = /data-type\s*=\s*["']taskList["']/i.test(list[2] ?? '');
      const start = Number(/start\s*=\s*["']?(\d+)/i.exec(list[2] ?? '')?.[1] ?? 1);
      const node: DocNode =
        list[1]!.toLowerCase() === 'ol'
          ? { type: 'orderedList', attrs: { start }, content: [] }
          : { type: task ? 'taskList' : 'bulletList', content: [] };
      (container().content ??= []).push(node);
      containers.push(node);
      paragraph = null;
    } else if (item && containers.length > 1) {
      flush();
      const parent = container();
      const node: DocNode =
        parent.type === 'taskList'
          ? {
              type: 'taskItem',
              attrs: { checked: /data-checked\s*=\s*["']true["']/i.test(item[1] ?? '') },
              content: [],
            }
          : { type: 'listItem', content: [] };
      (parent.content ??= []).push(node);
      containers.push(node);
      paragraph = null;
    } else if (CELL_ITEM_CLOSE.test(html) && containers.length > 1) {
      flush();
      while (containers.length > 1 && !/Item$/.test(container().type)) containers.pop();
      if (containers.length > 1) containers.pop();
      paragraph = null;
    } else if (CELL_LIST_CLOSE.test(html) && containers.length > 1) {
      flush();
      while (containers.length > 1 && !/List$/.test(container().type)) containers.pop();
      if (containers.length > 1) containers.pop();
      paragraph = null;
    } else if (/^<br\s*\/?>$/i.test(html) && !paragraph && !run.length) {
      // the line break written between a list and the text after it
    } else run.push(token);
  }
  flush();
  // the paragraph every cell starts with goes when the cell begins with a list instead
  if (!first.content?.length && (cell.content?.length ?? 0) > 1)
    cell.content = cell.content!.filter((node) => node !== first);
}

interface Builder {
  push: (node: DocNode) => void;
  top: () => DocNode;
  close: () => void;
  stack: DocNode[];
}

// the icon notion writes at the start of a callout: a custom emoji or one of its own icon pictures
const NOTION_ICON = /^<img\s[^>]*src=["'](?:notion:\/\/custom_emoji\/|\/icons\/)[^>]*>\s*/i;

// toggles and notion asides become blocks, any other html is kept exactly as written
function htmlBlock(source: string, options: ParseOptions, b: Builder): void {
  const html = source.trim();
  if (NOTION_ICON.test(html) && !html.replace(NOTION_ICON, '').trim()) return;
  // an empty line kept on purpose, the way morrow writes one
  if (/^<br\s*\/?>$/i.test(html)) {
    b.push({ type: 'paragraph', content: [] });
    return;
  }
  if (/^<!--\s*toc\s*-->$/i.test(html)) {
    b.push({ type: 'tableOfContents' });
    return;
  }
  // column wrappers come as runs of bare tags, each one opens or closes a level
  const layoutTags = html.match(/<div data-columns>|<div data-column>|<\/div>/gi);
  if (layoutTags && html.replace(/<div data-columns>|<div data-column>|<\/div>/gi, '').trim() === '') {
    const inLayout = b.stack.some((node) => node.type === 'columns');
    if (inLayout || /<div data-columns>/i.test(html)) {
      for (const tag of layoutTags) {
        if (/data-columns/i.test(tag)) {
          const node: DocNode = { type: 'columns', content: [] };
          b.push(node);
          b.stack.push(node);
        } else if (/data-column/i.test(tag)) {
          if (b.top().type !== 'columns') continue;
          const node: DocNode = { type: 'column', content: [] };
          b.push(node);
          b.stack.push(node);
        } else if (b.top().type === 'column' || b.top().type === 'columns') b.close();
      }
      return;
    }
  }
  const details = /^<details[^>]*>/i.exec(html);
  const aside = /^<aside[^>]*>/i.exec(html);
  if (details) {
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(html);
    const title = decodeEntities((summary?.[1] ?? '').replace(/<[^>]+>/g, '')).trim();
    // <summary><h2>…</h2></summary> is a toggle heading
    const level = toggleLevel(Number(/^\s*<h([1-6])\b/i.exec(summary?.[1] ?? '')?.[1]));
    const body: DocNode = { type: 'detailsContent', content: [] };
    const node: DocNode = {
      type: 'details',
      attrs: { open: /^<details\b[^>]*\sopen\b/i.test(details[0]) },
      content: [
        {
          type: 'detailsSummary',
          ...(level ? { attrs: { level } } : {}),
          content: summaryContent(title, options),
        },
        body,
      ],
    };
    b.push(node);
    const after = html.slice(summary ? summary.index + summary[0].length : details[0].length);
    const closed = /<\/details>\s*$/i.test(after);
    const inner = after.replace(/<\/details>\s*$/i, '').trim();
    if (inner)
      body.content!.push(
        ...(markdownToDoc(inner, { ...options, allowLegacyBlockBackgrounds: false }).content ?? []),
      );
    if (!closed) b.stack.push(node, body);
  } else if (/^<\/details>/i.test(html)) {
    if (b.top().type === 'detailsContent') {
      b.close();
      b.close();
    }
  } else if (aside) {
    const closed = /<\/aside>\s*$/i.test(html);
    let inner = html
      .slice(aside[0].length)
      .replace(/<\/aside>\s*$/i, '')
      .trim()
      .replace(NOTION_ICON, '');
    // notion writes the callout's emoji as the first thing in it
    const emoji =
      /^(\p{Extended_Pictographic}[\uFE0F\u200D\p{Extended_Pictographic}\p{Emoji_Modifier}]*)\s+/u.exec(
        inner,
      );
    const node: DocNode = {
      type: 'callout',
      attrs: { tone: 'note', kind: 'note', ...(emoji ? { icon: emoji[1] } : {}) },
      content: [],
    };
    if (emoji) inner = inner.slice(emoji[0].length);
    if (inner)
      node.content!.push(
        ...(markdownToDoc(inner, { ...options, allowLegacyBlockBackgrounds: false }).content ?? []),
      );
    b.push(node);
    if (!closed) b.stack.push(node);
  } else if (/^<\/aside>/i.test(html)) {
    if (b.top().type === 'callout') b.close();
  } else if (html) b.push({ type: 'rawBlock', attrs: { text: source.replace(/\n+$/, '') } });
}

// a toggle's title is written as markdown, so links and bold in it come back as they were. it only holds
// text, anything else in it, like a [[link]], is kept as its words
function summaryContent(title: string, options: ParseOptions): DocNode[] {
  if (!title) return [];
  const tokens = md.parseInline(title, {})[0]?.children ?? [];
  const nodes = inlineNodes(tokens, options).map((child): DocNode => {
    if (child.type === 'text') return child;
    const text = child.type === 'hardBreak' || child.type === 'softBreak' ? ' ' : inlineText(child);
    return { type: 'text', text, ...(child.marks?.length ? { marks: child.marks } : {}) };
  });
  return mergeText(nodes.filter((child) => child.text));
}

// first level one heading becomes the page title
export function markdownToPage(
  source: string,
  fallbackTitle: string,
  options: ParseOptions = {},
): { title: string; doc: DocNode } {
  const doc = markdownToDoc(source, options);
  const first = doc.content?.[0];
  if (first?.type === 'heading' && first.attrs?.level === 1) {
    const rest = doc.content!.slice(1);
    return {
      title: inlineText(first).trim() || fallbackTitle,
      doc: rest.length ? { type: 'doc', content: rest } : emptyDoc(),
    };
  }
  return { title: fallbackTitle, doc };
}

/** Inspects legacy background comments using the same Markdown token stream as the codec. */
export function inspectBlockBackgroundMarkers(
  source: string,
  resolvesAttachment?: (href: string) => boolean,
): BlockBackgroundMarkerInspection[] {
  const text = source.length > MAX_INPUT ? source.slice(0, MAX_INPUT) : source;
  if (!/<!--[ \t\r\n]*morrow:block-background(?=[\s:>])/i.test(text)) return [];
  const resolveFile = resolvesAttachment
    ? (href: string) =>
        resolvesAttachment(href)
          ? {
              fileId: href,
              name: href.split('/').at(-1) || href,
              image: /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(href),
            }
          : null
    : undefined;
  return parseMarkdownToDoc(text, { resolveFile }).blockBackgroundMarkers;
}

function inspectBlockBackgroundMarkerTokens(tokens: Token[]): BlockBackgroundMarkerInspection[] {
  const found: BlockBackgroundMarkerInspection[] = [];
  const listItems: number[] = [];
  const htmlContainers: Array<{
    tag: string;
    nativeColumnLayout: boolean;
    layoutKind: 'columns' | 'column' | 'other';
  }> = [];
  let blockquoteDepth = 0;
  let tableDepth = 0;
  let rootContentSeen = false;

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex]!;
    if (token.type === 'list_item_open') listItems.push(token.level);
    if (token.type === 'list_item_close') {
      while (listItems.length && listItems[listItems.length - 1]! >= token.level) listItems.pop();
    }

    if (token.type === 'html_block' || token.type === 'html_inline') {
      const comments = blockBackgroundComments(token.content);
      for (const comment of comments) {
        const color = parseBlockBackgroundMarker(comment);
        const next = tokens[tokenIndex + 1];
        const syntheticEmptyParagraph =
          next?.type === 'html_block' && /^<br\s*\/?>$/i.test(next.content.trim());
        const targetType =
          next && ['paragraph_open', 'heading_open', 'blockquote_open'].includes(next.type)
            ? next.type
            : syntheticEmptyParagraph
              ? 'paragraph_open'
              : null;
        const targetTag = targetType && next ? (syntheticEmptyParagraph ? 'p' : next.tag) : null;
        const layoutIsSupported =
          htmlContainers.length === 0 ||
          (htmlContainers.at(-1)?.layoutKind === 'column' &&
            htmlContainers.some((container) => container.nativeColumnLayout) &&
            htmlContainers.every((container) => container.nativeColumnLayout));
        const isColumnChild = htmlContainers.length === 0 || htmlContainers.at(-1)?.layoutKind === 'column';
        const previousBackground = tokens[tokenIndex - 1];
        const duplicateBackground =
          previousBackground?.type === 'html_block' &&
          (parseBlockBackgroundMarker(previousBackground.content.trim()) !== null ||
            BACKGROUND_PATTERN.test(previousBackground.content.trim()));
        const approved =
          token.type === 'html_block' &&
          token.content.trim() === comment &&
          color !== null &&
          !duplicateBackground &&
          targetType !== null &&
          next?.level === token.level &&
          listItems.length === 0 &&
          tableDepth === 0 &&
          layoutIsSupported &&
          isColumnChild;
        const titleHeading =
          approved &&
          targetType === 'heading_open' &&
          targetTag === 'h1' &&
          next?.level === 0 &&
          htmlContainers.length === 0 &&
          blockquoteDepth === 0 &&
          !rootContentSeen;
        found.push({
          comment,
          color,
          tokenIndex,
          tokenType: token.type,
          approved,
          targetType,
          targetTag,
          titleHeading,
        });
      }
    }

    if (token.type === 'blockquote_open') blockquoteDepth++;
    if (token.type === 'blockquote_close') blockquoteDepth = Math.max(0, blockquoteDepth - 1);
    if (token.type === 'table_open') tableDepth++;
    if (token.type === 'table_close') tableDepth = Math.max(0, tableDepth - 1);

    if (token.type === 'html_block') updateBlockBackgroundHtmlContainers(token.content, htmlContainers);

    if (token.level === 0 && isRootContentToken(token)) rootContentSeen = true;
  }
  return found;
}

function proveBlockBackgroundOwners(
  doc: DocNode,
  markers: BlockBackgroundMarkerInspection[],
  invalidMarkerIds: ReadonlySet<number>,
): BlockBackgroundMarkerInspection[] {
  const owners = new Map<number, Array<{ node: DocNode; ancestors: DocNode[] }>>();
  const visit = (node: DocNode, ancestors: DocNode[]) => {
    for (const markerId of (node as MarkerOwnedDocNode)[BLOCK_BACKGROUND_MARKER_IDS] ?? []) {
      owners.set(markerId, [...(owners.get(markerId) ?? []), { node, ancestors }]);
    }
    for (const child of node.content ?? []) visit(child, [...ancestors, node]);
  };
  visit(doc, []);

  return markers.map((marker) => {
    if (!marker.approved) return marker;
    const candidates = owners.get(marker.tokenIndex) ?? [];
    const owner = candidates[0];
    const expectedNodeType =
      marker.targetType === 'paragraph_open'
        ? 'paragraph'
        : marker.targetType === 'heading_open'
          ? 'heading'
          : marker.targetType === 'blockquote_open'
            ? 'blockquote'
            : null;
    const supportedChain = owner
      ? supportsHexBlockBackgroundOwner(
          owner.node.type,
          owner.ancestors.map((ancestor) => ancestor.type),
        )
      : false;
    const proven =
      candidates.length === 1 &&
      !invalidMarkerIds.has(marker.tokenIndex) &&
      expectedNodeType !== null &&
      owner?.node.type === expectedNodeType &&
      owner?.node.attrs?.backgroundColor === marker.color &&
      supportedChain === true;
    return { ...marker, approved: proven };
  });
}

function removeBlockBackgroundMarkerIds(doc: DocNode, markers: BlockBackgroundMarkerInspection[]): void {
  const approved = new Set(markers.filter((marker) => marker.approved).map((marker) => marker.tokenIndex));
  const visit = (node: DocNode) => {
    const owned = node as MarkerOwnedDocNode;
    const markerIds = owned[BLOCK_BACKGROUND_MARKER_IDS] ?? [];
    if (markerIds.length && markerIds.some((markerId) => !approved.has(markerId))) {
      if (node.attrs && Object.hasOwn(node.attrs, 'backgroundColor')) {
        const attrs = { ...node.attrs };
        delete attrs.backgroundColor;
        node.attrs = Object.keys(attrs).length ? attrs : undefined;
      }
    }
    Reflect.deleteProperty(owned, BLOCK_BACKGROUND_MARKER_IDS);
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
}

function blockBackgroundComments(content: string): string[] {
  const comments: string[] = [];
  const opening = /<!--[ \t\r\n]*morrow:block-background(?=[\s:>])/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(content))) {
    const end = content.indexOf('-->', match.index);
    comments.push((end === -1 ? content.slice(match.index) : content.slice(match.index, end + 3)).trim());
  }
  return comments;
}

function updateBlockBackgroundHtmlContainers(
  content: string,
  stack: Array<{
    tag: string;
    nativeColumnLayout: boolean;
    layoutKind: 'columns' | 'column' | 'other';
  }>,
): void {
  const tags = content.match(/<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (tag.startsWith('<!--')) continue;
    const closing = /^<\/([a-z][\w-]*)\s*>$/i.exec(tag);
    if (closing) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index]!.tag !== closing[1]!.toLowerCase()) index--;
      if (index >= 0) stack.splice(index);
      continue;
    }
    const opening = /^<([a-z][\w-]*)\b([^>]*)>$/i.exec(tag);
    if (!opening || /\/\s*>$/.test(tag)) continue;
    const name = opening[1]!.toLowerCase();
    const exactTag = tag.toLowerCase();
    if (name === 'div' && exactTag === '<div data-columns>') {
      stack.push({ tag: 'div', nativeColumnLayout: true, layoutKind: 'columns' });
    } else if (
      name === 'div' &&
      exactTag === '<div data-column>' &&
      stack.at(-1)?.layoutKind === 'columns' &&
      stack.at(-1)?.nativeColumnLayout
    ) {
      stack.push({ tag: 'div', nativeColumnLayout: true, layoutKind: 'column' });
    } else if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(name)) {
      stack.push({ tag: name, nativeColumnLayout: false, layoutKind: 'other' });
    }
  }
}

function isRootContentToken(token: Token): boolean {
  if (
    [
      'paragraph_open',
      'heading_open',
      'blockquote_open',
      'bullet_list_open',
      'ordered_list_open',
      'fence',
      'code_block',
      'math_block',
      'hr',
      'table_open',
    ].includes(token.type)
  ) {
    return true;
  }
  if (token.type !== 'html_block') return false;
  const value = token.content.trim();
  if (
    parseBlockBackgroundMarker(value) ||
    BACKGROUND_PATTERN.test(value) ||
    ALIGN_PATTERN.test(value) ||
    value === HEADER_COLUMN ||
    value === EMBED_TITLE_COMMENT ||
    value === PREVIEW_COMMENT ||
    value === LETTERS_COMMENT ||
    COLUMN_WIDTHS_PATTERN.test(value)
  ) {
    return false;
  }
  return true;
}

export interface MarkdownRetargetSpan {
  kind: 'markdown' | 'wiki';
  start: number;
  end: number;
  raw: string;
  target?: string;
  targetStart?: number;
  targetEnd?: number;
}

interface InlineSourceLine {
  rawStart: number;
  localStart: number;
  localEnd: number;
  contentColumn: number;
}

/** Returns exact source ranges for links accepted by Morrow's configured Markdown parser. */
export function markdownRetargetSpans(source: string): MarkdownRetargetSpan[] {
  if (source.length > MAX_INPUT) return [];
  const normalized = source.replace(/\r\n?/g, '\n');
  let tokens: Token[];
  try {
    tokens = md.parse(normalized, { morrowRetargetSourceMaps: true });
  } catch {
    return [];
  }

  const normalizedLineStarts = markdownLineStarts(normalized);
  const rawLineStarts = markdownLineStarts(source);
  const cursors = new Map<number, number>();
  const spans: MarkdownRetargetSpan[] = [];
  let tableRowMap: [number, number] | null = null;

  for (const block of tokens) {
    if (block.type === 'tr_close') tableRowMap = null;
    if (block.type === 'tr_open') tableRowMap = block.map as [number, number] | null;
    if (block.type !== 'inline' || !block.children) continue;

    const lineMap = (block.map as [number, number] | null) ?? tableRowMap;
    const tableMap = tableCellSourceMap(block.meta);
    if (!tableMap && !lineMap) continue;
    const lines = tableMap
      ? null
      : mapInlineSourceLines(
          block.content,
          lineMap!,
          normalized,
          normalizedLineStarts,
          rawLineStarts,
          cursors,
        );
    if (!tableMap && !lines) continue;
    const mapRange = (start: number, end: number) =>
      tableMap
        ? mapTableCellSourceRange(
            block.content,
            tableMap,
            start,
            end,
            normalizedLineStarts,
            rawLineStarts,
            normalized.length,
            source.length,
          )
        : mapInlineSourceRange(block.content, lines!, start, end);
    const sourceMatches = (raw: string, expected: string) =>
      (tableMap ? unescapeTablePipes(raw) : raw) === expected;

    const visit = (children: Token[]) => {
      for (const token of children) {
        const meta = token.meta as Record<string, unknown> | null;
        if (token.type === 'wikilink' && meta) {
          const range = sourceRange(meta.morrowRetargetRange);
          const targetRange = sourceRange(meta.morrowRetargetTargetRange);
          const target = typeof meta.target === 'string' ? meta.target : undefined;
          const mapped = range ? mapRange(range.start, range.end) : null;
          const mappedTarget = targetRange && target ? mapRange(targetRange.start, targetRange.end) : null;
          if (mapped) {
            const raw = source.slice(mapped.start, mapped.end);
            if (sourceMatches(raw, token.markup) && mappedTarget && target) {
              const rawTarget = source.slice(mappedTarget.start, mappedTarget.end);
              if (!sourceMatches(rawTarget, target)) {
                if (token.children) visit(token.children);
                continue;
              }
              spans.push({
                kind: 'wiki',
                start: mapped.start,
                end: mapped.end,
                raw,
                target,
                targetStart: mappedTarget.start,
                targetEnd: mappedTarget.end,
              });
            }
          }
        } else if (token.type === 'link_open' && meta?.morrowMarkdownHrefScanned === true) {
          const range = sourceRange(meta.morrowMarkdownHrefRange);
          const href = typeof meta.markdownHref === 'string' ? meta.markdownHref : null;
          const mapped = range ? mapRange(range.start, range.end) : null;
          if (href !== null && mapped) {
            const raw = source.slice(mapped.start, mapped.end);
            if (sourceMatches(raw, href))
              spans.push({ kind: 'markdown', start: mapped.start, end: mapped.end, raw });
          }
        }
        if (token.children) visit(token.children);
      }
    };
    visit(block.children);
  }

  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const nonOverlapping: MarkdownRetargetSpan[] = [];
  let previousEnd = -1;
  for (const span of spans) {
    if (span.start < previousEnd) continue;
    nonOverlapping.push(span);
    previousEnd = span.end;
  }
  return nonOverlapping;
}

function tableCellSourceMap(value: unknown): TableCellSourceMap | null {
  if (!value || typeof value !== 'object') return null;
  const map = (value as Record<string, unknown>).morrowTableCellSourceMap;
  if (!map || typeof map !== 'object') return null;
  const candidate = map as { normalizedStart?: unknown; removedBefore?: unknown };
  const removedBefore = candidate.removedBefore;
  if (
    !Number.isInteger(candidate.normalizedStart) ||
    !(Array.isArray(removedBefore) || removedBefore instanceof Uint32Array)
  )
    return null;
  for (let index = 0; index < removedBefore.length; index++) {
    const offset = removedBefore[index];
    if (!Number.isInteger(offset) || Number(offset) < 0 || (index > 0 && offset! < removedBefore[index - 1]!))
      return null;
  }
  return {
    normalizedStart: Number(candidate.normalizedStart),
    removedBefore,
  };
}

function mapTableCellSourceRange(
  content: string,
  map: TableCellSourceMap,
  start: number,
  end: number,
  normalizedLineStarts: number[],
  rawLineStarts: number[],
  normalizedLength: number,
  rawLength: number,
): { start: number; end: number } | null {
  if (start < 0 || end > content.length || end <= start) return null;
  const removedBefore = (offset: number) => {
    let low = 0;
    let high = map.removedBefore.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (map.removedBefore[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const normalizedStart = map.normalizedStart + start + removedBefore(start);
  const normalizedEnd = map.normalizedStart + end + removedBefore(end);
  const rawStart = normalizedToRawOffset(
    normalizedStart,
    normalizedLineStarts,
    rawLineStarts,
    normalizedLength,
    rawLength,
  );
  const rawEnd = normalizedToRawOffset(
    normalizedEnd,
    normalizedLineStarts,
    rawLineStarts,
    normalizedLength,
    rawLength,
  );
  return rawStart === null || rawEnd === null || rawEnd <= rawStart ? null : { start: rawStart, end: rawEnd };
}

function normalizedToRawOffset(
  offset: number,
  normalizedLineStarts: number[],
  rawLineStarts: number[],
  normalizedLength: number,
  rawLength: number,
): number | null {
  if (offset < 0 || offset > normalizedLength) return null;
  if (offset === normalizedLength) return rawLength;
  let low = 0;
  let high = normalizedLineStarts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (normalizedLineStarts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  const line = low - 1;
  const normalizedStart = normalizedLineStarts[line];
  const rawStart = rawLineStarts[line];
  if (normalizedStart === undefined || rawStart === undefined) return null;
  return rawStart + offset - normalizedStart;
}

function sourceRange(value: unknown): { start: number; end: number } | null {
  if (!value || typeof value !== 'object') return null;
  const range = value as { start?: unknown; end?: unknown };
  return Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    Number(range.end) > Number(range.start)
    ? { start: Number(range.start), end: Number(range.end) }
    : null;
}

function markdownLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      starts.push(index + 1);
    } else if (source[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

function mapInlineSourceLines(
  content: string,
  lineMap: [number, number],
  normalized: string,
  normalizedLineStarts: number[],
  rawLineStarts: number[],
  cursors: Map<number, number>,
): Array<InlineSourceLine | null> | null {
  const localLineStarts = [0];
  for (let index = 0; index < content.length; index++)
    if (content[index] === '\n') localLineStarts.push(index + 1);
  const localLineCount =
    localLineStarts.length === lineMap[1] - lineMap[0] + 1 && content.endsWith('\n')
      ? localLineStarts.length - 1
      : localLineStarts.length;
  const sourceLineCount = lineMap[1] - lineMap[0];
  if (sourceLineCount < 1) return null;

  const lines: Array<InlineSourceLine | null> = [];
  let nextSourceLine = lineMap[0];
  for (let index = 0; index < localLineCount; index++) {
    const localStart = localLineStarts[index]!;
    const localEnd = index + 1 < localLineStarts.length ? localLineStarts[index + 1]! - 1 : content.length;
    const inlineLine = content.slice(localStart, localEnd);
    if (!inlineLine) {
      lines.push(null);
      continue;
    }

    const candidateLines =
      localLineCount === sourceLineCount
        ? [lineMap[0] + index]
        : Array.from(
            { length: Math.max(0, lineMap[1] - nextSourceLine) },
            (_, offset) => nextSourceLine + offset,
          );
    const candidates: Array<{ line: number; rawStart: number; contentColumn: number }> = [];
    for (const line of candidateLines) {
      const normalizedStart = normalizedLineStarts[line];
      const rawStart = rawLineStarts[line];
      if (normalizedStart === undefined || rawStart === undefined) continue;
      const normalizedEnd = normalizedLineStarts[line + 1] ?? normalized.length;
      const sourceLineEnd =
        normalizedEnd > normalizedStart && normalized[normalizedEnd - 1] === '\n'
          ? normalizedEnd - 1
          : normalizedEnd;
      const sourceLine = normalized.slice(normalizedStart, sourceLineEnd);
      const cursor = cursors.get(line) ?? 0;
      const contentColumn = sourceLine.indexOf(inlineLine, cursor);
      if (contentColumn < 0) continue;
      if (localLineCount !== sourceLineCount && sourceLine.indexOf(inlineLine, contentColumn + 1) !== -1)
        continue;
      candidates.push({ line, rawStart, contentColumn });
    }
    if (candidates.length !== 1) {
      lines.push(null);
      continue;
    }
    const mapped = candidates[0]!;
    cursors.set(mapped.line, mapped.contentColumn + inlineLine.length);
    nextSourceLine = Math.max(nextSourceLine, mapped.line + 1);
    lines.push({ rawStart: mapped.rawStart, localStart, localEnd, contentColumn: mapped.contentColumn });
  }
  return lines;
}

function mapInlineSourceRange(
  content: string,
  lines: Array<InlineSourceLine | null>,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start < 0 || end > content.length || end <= start) return null;
  let lineIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line && start >= line.localStart && end <= line.localEnd) {
      lineIndex = index;
      break;
    }
  }
  if (lineIndex === -1) return null;
  const line = lines[lineIndex]!;
  const localColumnStart = start - line.localStart;
  const localColumnEnd = end - line.localStart;
  return {
    start: line.rawStart + line.contentColumn + localColumnStart,
    end: line.rawStart + line.contentColumn + localColumnEnd,
  };
}

// a time written just after a date, [[2026-11-10]] 17:05, belongs to the date
function dateTimes(nodes: DocNode[]): DocNode[] {
  for (let index = 0; index < nodes.length - 1; index++) {
    const date = nodes[index]!;
    const next = nodes[index + 1]!;
    if (date.type !== 'dateMention' || next.type !== 'text' || next.marks?.length) continue;
    const match = /^ (([01]\d|2[0-3]):[0-5]\d)(?![\d:])/.exec(next.text ?? '');
    if (!match) continue;
    date.attrs = { ...date.attrs, time: match[1] };
    const rest = next.text!.slice(match[0].length);
    if (rest) next.text = rest;
    else nodes.splice(index + 1, 1);
  }
  return nodes;
}

function inlineNodes(tokens: Token[], options: ParseOptions): DocNode[] {
  const out: DocNode[] = [];
  const marks: DocMark[] = [];
  const add = (text: string, extra: DocMark[] = []) => {
    if (!text) return;
    const all = [...marks, ...extra];
    out.push(all.length ? { type: 'text', text, marks: all } : { type: 'text', text });
  };
  const remove = (type: string) => {
    const index = marks.map((mark) => mark.type).lastIndexOf(type);
    if (index !== -1) marks.splice(index, 1);
  };
  let pageTarget: { id: PageId; label: string; markdownHref: string | null; anchor: string | null } | null =
    null;

  for (const token of tokens) {
    if (pageTarget && token.type !== 'link_close') {
      pageTarget.label += token.content;
      continue;
    }
    switch (token.type) {
      case 'text':
        add(token.content);
        break;
      case 'softbreak':
        // kept until callout titles are read, then becomes a space
        out.push({ type: 'softBreak' });
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
        break;
      case 'strong_open':
        marks.push({ type: 'bold' });
        break;
      case 'em_open':
        marks.push({ type: 'italic' });
        break;
      case 's_open':
        marks.push({ type: 'strike' });
        break;
      case 'mark_open':
        marks.push({ type: 'highlight' });
        break;
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '');
        const scannedInlineLink = token.meta?.morrowMarkdownHrefScanned === true;
        const markdownHref = typeof token.meta?.markdownHref === 'string' ? token.meta.markdownHref : null;
        const pageId =
          scannedInlineLink && options.resolveMarkdownPageLink
            ? markdownHref === null
              ? null
              : (options.resolveMarkdownPageLink(markdownHref) ?? null)
            : (options.resolveLink?.(href) ?? null);
        const file = pageId ? null : (options.resolveFile?.(href) ?? null);
        if (pageId) pageTarget = { id: pageId, label: '', markdownHref, anchor: markdownAnchor(href) };
        else if (file) marks.push({ type: 'link', attrs: { href, fileRef: file } });
        else marks.push({ type: 'link', attrs: { href } });
        break;
      }
      case 'strong_close':
        remove('bold');
        break;
      case 'em_close':
        remove('italic');
        break;
      case 's_close':
        remove('strike');
        break;
      case 'mark_close':
        remove('highlight');
        break;
      case 'link_close':
        if (pageTarget) {
          const label = pageTarget.label.trim();
          out.push({
            type: 'pageLink',
            attrs: {
              id: pageTarget.id,
              label,
              alias: label,
              ...(pageTarget.markdownHref !== null ? { markdownHref: pageTarget.markdownHref } : {}),
              ...(pageTarget.anchor !== null ? { anchor: pageTarget.anchor } : {}),
            },
          });
          pageTarget = null;
        } else remove('link');
        break;
      case 'code_inline':
        add(token.content, [{ type: 'code' }]);
        break;
      case 'math_inline':
        out.push({ type: 'inlineMath', attrs: { latex: token.content } });
        break;
      case 'wikilink':
        out.push(...wikiNode(token.meta as unknown as WikiLink, token.markup, options, marks));
        break;
      case 'image': {
        const src = String(token.attrGet('src') ?? '');
        const { alt, width } = sizedAlt(token.content || String(token.attrGet('alt') ?? ''));
        const sized = width ? { width } : {};
        const file = options.resolveFile?.(src) ?? null;
        if (file?.image) out.push({ type: 'image', attrs: { fileId: file.fileId, alt, ...sized } });
        else if (file) add(alt || file.name, [{ type: 'link', attrs: { href: src, fileRef: file } }]);
        else out.push({ type: 'image', attrs: { fileId: null, src, alt, ...sized } });
        break;
      }
      case 'html_inline': {
        const tag = token.content.trim().toLowerCase();
        const styled =
          /^<(span|mark)\s+style\s*=\s*(["'])\s*(color|background(?:-color)?)\s*:\s*(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z]+)\s*;?\s*\2\s*>$/.exec(
            tag,
          );
        const isTextColor = styled?.[1] === 'span' && styled[3] === 'color';
        const isHighlightColor =
          styled?.[1] === 'mark' && (styled[3] === 'background' || styled[3] === 'background-color');
        const color =
          styled && isTextColor
            ? parseInlineColor(styled[4]!, TEXT_HEX)
            : styled && isHighlightColor
              ? parseInlineColor(styled[4]!, BACKGROUND_HEX)
              : null;
        if (styled && color && isTextColor) marks.push({ type: 'textColor', attrs: { color } });
        else if (styled && color && isHighlightColor) marks.push({ type: 'highlight', attrs: { color } });
        else if (tag === '</span>' && marks.some((mark) => mark.type === 'textColor')) remove('textColor');
        else if (tag === '<u>') marks.push({ type: 'underline' });
        else if (tag === '</u>') remove('underline');
        else if (tag === '<mark>') marks.push({ type: 'highlight' });
        else if (tag === '</mark>') remove('highlight');
        else if (/^<br\s*\/?>$/.test(tag)) out.push({ type: 'hardBreak' });
        else if (!NOTION_ICON.test(token.content.trim())) add(token.content);
        break;
      }
      default:
        if (token.content) add(token.content);
    }
  }
  return dateTimes(mergeText(out));
}

function markdownAnchor(href: string): string | null {
  const hash = href.indexOf('#');
  if (hash === -1) return null;
  const fragment = href.slice(hash + 1);
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

export interface MarkdownHrefPath {
  // A vault-relative path after CommonMark unescaping, entity decoding and one URL decode per segment.
  path: string;
  // The query/fragment suffix exactly as captured from the Markdown source.
  suffix: string;
}

/**
 * Converts a scanner-captured Markdown href into its CommonMark path semantics while leaving its
 * query/fragment suffix untouched. Path decoding stays segment-local so encoded separators cannot
 * change which vault file a link names.
 */
export function markdownHrefPath(href: string): MarkdownHrefPath | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null;
  const suffixStart = href.search(/[?#]/);
  const rawPath = suffixStart === -1 ? href : href.slice(0, suffixStart);
  if (!rawPath) return null;

  const commonMarkSegments = rawPath.split('/').map((segment) => md.utils.unescapeAll(segment));
  const commonMarkPath = commonMarkSegments.join('/');
  if (/^[a-z][a-z0-9+.-]*:/i.test(commonMarkPath) || commonMarkPath.startsWith('//')) return null;
  const pathSegments: string[] = [];
  for (const commonMarkSegment of commonMarkSegments) {
    if (/[/?#\\]/.test(commonMarkSegment)) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(commonMarkSegment);
    } catch {
      segment = commonMarkSegment;
    }
    if (/[\\/]/.test(segment)) return null;
    pathSegments.push(segment);
  }

  return {
    path: pathSegments.join('/'),
    suffix: suffixStart === -1 ? '' : href.slice(suffixStart),
  };
}

// obsidian sizes a picture in its alt text: "a cat|300", "a cat|300x200", or just "300" in an embed
function sizedAlt(text: string): { alt: string; width: number | null } {
  const match = /^(?:(.*)\|)?(\d{2,4})(?:x\d{2,4})?$/.exec(text.trim());
  const width = match ? imageWidth(Number(match[2])) : null;
  return width ? { alt: (match![1] ?? '').trim(), width } : { alt: text, width: null };
}

function wikiNode(link: WikiLink, markup: string, options: ParseOptions, marks: DocMark[]): DocNode[] {
  if (link.embed) {
    const file = link.target ? (options.resolveFile?.(link.target) ?? null) : null;
    if (file?.image) {
      const { alt, width } = sizedAlt(link.alias ?? '');
      return [{ type: 'image', attrs: { fileId: file.fileId, alt, ...(width ? { width } : {}) } }];
    }
    if (file) {
      const fileMarks = [
        ...marks,
        { type: 'link', attrs: { href: link.target, fileRef: { ...file, embed: true } } },
      ];
      return [{ type: 'text', text: link.alias ?? file.name, marks: fileMarks }];
    }
  }
  // [[2026-10-16]] is a date, which opens that day's note. it stays a date once the note exists, rather
  // than becoming a link titled with the day written out, which lost its reminder and could not be edited
  if (!link.embed && link.alias === null && link.anchor === null && /^\d{4}-\d{2}-\d{2}$/.test(link.target))
    return [{ type: 'dateMention', attrs: { date: link.target } }];
  const id = link.target ? (options.resolvePage?.(link.target) ?? null) : null;
  if (!id && options.keepUnresolved === false) {
    return [
      marks.length ? { type: 'text', text: markup, marks: [...marks] } : { type: 'text', text: markup },
    ];
  }
  const label = link.alias ?? (link.target.split('/').pop() || link.target);
  // the written target is only needed while the page does not exist, resolved links follow the page
  const attrs: Record<string, unknown> = id ? { id, label } : { id, label, target: link.target };
  if (link.anchor !== null) attrs.anchor = link.anchor;
  if (link.alias !== null) attrs.alias = link.alias;
  if (link.embed) attrs.embed = true;
  return [{ type: 'pageLink', attrs }];
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function mergeText(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    const last = out[out.length - 1];
    if (last?.type === 'text' && node.type === 'text' && sameMarks(last.marks, node.marks)) {
      out[out.length - 1] = { ...last, text: (last.text ?? '') + (node.text ?? '') };
    } else out.push(node);
  }
  return out;
}

function sameMarks(a: DocMark[] = [], b: DocMark[] = []): boolean {
  return (
    a.length === b.length &&
    a.every(
      (mark, i) =>
        mark.type === b[i]!.type &&
        mark.attrs?.href === b[i]!.attrs?.href &&
        mark.attrs?.color === b[i]!.attrs?.color &&
        mark.attrs?.fileRef === b[i]!.attrs?.fileRef,
    )
  );
}

// shapes the tree so the editor schema accepts it
function normalize(input: DocNode, invalidMarkerIds: Set<number>): DocNode {
  // callouts read their title from the raw first line, before line breaks turn into spaces
  const node = input.type === 'blockquote' ? toCallout(input) : input;
  if (node !== input) invalidateBlockBackgroundMarkers(input, invalidMarkerIds);
  const content = node.content?.flatMap((child) =>
    liftMedia(normalize(child, invalidMarkerIds), invalidMarkerIds),
  );
  let next: DocNode = content ? { ...node, content } : { ...node };
  if ((next.type === 'callout' || next.type === 'detailsContent') && (next.content ?? []).length === 0) {
    next = { ...next, content: [{ type: 'paragraph', content: [] }] };
  }

  if (
    next.type === 'listItem' ||
    next.type === 'tableCell' ||
    next.type === 'tableHeader' ||
    next.type === 'blockquote'
  ) {
    const children = next.content ?? [];
    if (children.length === 0 || (next.type === 'listItem' && children[0]!.type !== 'paragraph')) {
      next = { ...next, content: [{ type: 'paragraph', content: [] }, ...children] };
    }
  }
  if (next.type === 'bulletList') return next;
  if (next.content?.some((child) => child.type === 'bulletList')) {
    next = { ...next, content: next.content.flatMap(splitTaskLists) };
  }
  if (next.type === 'paragraph' || next.type === 'heading' || next.type === 'detailsSummary') {
    const inline = mergeText(
      (next.content ?? []).map((child) =>
        child.type === 'softBreak' ? { type: 'text', text: ' ', ...marksOf(child) } : child,
      ),
    );
    next = { ...next, content: inline.filter((child) => child.type !== 'text' || child.text) };
  }
  return next;
}

function marksOf(node: DocNode): { marks?: DocMark[] } {
  return node.marks?.length ? { marks: node.marks } : {};
}

// images and embeds become blocks, a paragraph that mixes them with text is split around them,
// so nothing an image or embed points at is ever lost
function liftMedia(node: DocNode, invalidMarkerIds: Set<number>): DocNode[] {
  if (node.type !== 'paragraph' || !node.content) return [node];
  const children = node.content;
  const markerIds = (node as MarkerOwnedDocNode)[BLOCK_BACKGROUND_MARKER_IDS] ?? [];
  const invalidate = () => invalidateBlockBackgroundMarkers(node, invalidMarkerIds);
  const blank = (child: DocNode) =>
    child.type === 'hardBreak' ||
    child.type === 'softBreak' ||
    (child.type === 'text' && !child.text?.trim());
  const meaningful = children.filter((child) => !blank(child));
  // a lone link to a stored file is shown as an attachment
  const refs = new Set(meaningful.map((child) => fileRefOf(child)));
  const ref = refs.size === 1 ? [...refs][0] : undefined;
  if (ref && meaningful.every((child) => fileRefOf(child) === ref)) {
    invalidate();
    return [mediaBlock(ref)];
  }
  if (!meaningful.some((child) => child.type === 'image' || fileRefOf(child)?.embed)) {
    return [{ ...node, content: children.map(plainFileLink) }];
  }
  if (markerIds.length) invalidate();
  const out: DocNode[] = [];
  let run: DocNode[] = [];
  const flush = () => {
    while (run.length && blank(run[0]!)) run.shift();
    while (run.length && blank(run[run.length - 1]!)) run.pop();
    if (run.length) {
      const content = mergeText(run);
      const last = content[content.length - 1]!;
      if (last.type === 'text') content[content.length - 1] = { ...last, text: last.text!.trimEnd() };
      out.push({ ...node, content: content.filter((child) => child.type !== 'text' || child.text) });
    }
    run = [];
  };
  // a picture set to one side keeps that side once it leaves its paragraph
  const align = node.attrs?.align;
  for (const child of children) {
    const embed = fileRefOf(child);
    if (child.type === 'image') {
      flush();
      out.push(align ? { ...child, attrs: { ...child.attrs, align } } : child);
    } else if (embed?.embed) {
      flush();
      out.push(mediaBlock(embed));
    } else run.push(plainFileLink(child));
  }
  flush();
  return out.length ? out : [{ ...node, content: [] }];
}

function invalidateBlockBackgroundMarkers(node: DocNode, invalidMarkerIds: Set<number>): void {
  for (const markerId of (node as MarkerOwnedDocNode)[BLOCK_BACKGROUND_MARKER_IDS] ?? [])
    invalidMarkerIds.add(markerId);
}

function mediaBlock(ref: { fileId: string; name: string; image: boolean }): DocNode {
  return ref.image
    ? { type: 'image', attrs: { fileId: ref.fileId, alt: '' } }
    : { type: 'fileAttachment', attrs: { fileId: ref.fileId, name: ref.name } };
}

// a link to a file inside a sentence stays an ordinary link to it
function plainFileLink(child: DocNode): DocNode {
  if (!fileRefOf(child)) return child;
  const marks = (child.marks ?? []).map((mark) =>
    mark.attrs?.fileRef ? { type: 'link', attrs: { href: mark.attrs.href } } : mark,
  );
  return { ...child, marks };
}

function fileRefOf(
  node: DocNode,
): { fileId: string; name: string; image: boolean; embed?: boolean } | undefined {
  const ref = node.marks?.find((mark) => mark.attrs?.fileRef)?.attrs?.fileRef;
  return ref as { fileId: string; name: string; image: boolean; embed?: boolean } | undefined;
}

// a quote that starts with [!type] is a callout, the rest of that first line is its title
function toCallout(quote: DocNode): DocNode {
  const [first, ...rest] = quote.content ?? [];
  const lead = first?.type === 'paragraph' ? first.content?.[0] : undefined;
  const match = lead?.type === 'text' && !lead.marks?.length ? CALLOUT.exec(lead.text ?? '') : null;
  if (!first || !lead || !match) return quote;
  const inline = [
    ...((lead.text ?? '').length > match[0].length
      ? [{ ...lead, text: lead.text!.slice(match[0].length) }]
      : []),
    ...(first.content ?? []).slice(1),
  ];
  const breakAt = inline.findIndex((node) => node.type === 'softBreak' || node.type === 'hardBreak');
  const titleNodes = breakAt === -1 ? inline : inline.slice(0, breakAt);
  const body = breakAt === -1 ? [] : inline.slice(breakAt + 1);
  const title = titleNodes
    .map((node) => inlineText(node))
    .join('')
    .trim();
  const kind = match[1]!.toLowerCase();
  const attrs: Record<string, unknown> = { tone: calloutTone(kind), kind };
  if (title) attrs.title = title;
  if (match[3]) attrs.fold = match[3];
  // morrow keeps a callout's icon as icon:🔥 in the metadata, anything else there is kept as it was
  const meta = (match[2] ?? '').split('|').filter((part) => part.trim());
  const icon = meta.find((part) => part.startsWith('icon:'));
  if (icon && calloutIcon(icon.slice(5))) attrs.icon = calloutIcon(icon.slice(5));
  const others = meta.filter((part) => part !== icon);
  if (others.length) attrs.meta = others.join('|');
  const content = body.length ? [{ ...first, content: body }, ...rest] : rest;
  return {
    type: 'callout',
    attrs,
    content: content.length ? content : [{ type: 'paragraph', content: [] }],
  };
}

// a bullet list whose items start with [ ] or [x] becomes a checklist, mixed lists are split
function splitTaskLists(node: DocNode): DocNode[] {
  if (node.type !== 'bulletList') return [node];
  const groups: DocNode[] = [];
  for (const item of node.content ?? []) {
    const task = toTaskItem(item);
    const type = task ? 'taskList' : 'bulletList';
    const last = groups[groups.length - 1];
    if (last?.type === type) last.content!.push(task ?? item);
    else groups.push({ type, content: [task ?? item] });
  }
  return groups;
}

function toTaskItem(item: DocNode): DocNode | null {
  const first = item.content?.[0];
  const lead = first?.type === 'paragraph' ? first.content?.[0] : undefined;
  if (!first || lead?.type !== 'text' || lead.marks?.length) return null;
  const match = TASK_PREFIX.exec(lead.text ?? '');
  if (!match) return null;
  const rest = (lead.text ?? '').slice(match[0].length);
  const inline = [...(rest ? [{ ...lead, text: rest }] : []), ...(first.content ?? []).slice(1)];
  return {
    type: 'taskItem',
    attrs: {
      checked: /x/i.test(match[1]!),
      ...(item.attrs?.backgroundColor ? { backgroundColor: item.attrs.backgroundColor } : {}),
    },
    content: [{ ...first, content: inline }, ...(item.content ?? []).slice(1)],
  };
}
