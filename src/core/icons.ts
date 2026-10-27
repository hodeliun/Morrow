import { MAX_ICON_LENGTH } from './model';

export type PageIcon =
  | { kind: 'emoji'; value: string }
  | { kind: 'lucide'; name: string; color: string | null }
  | { kind: 'file'; id: string; color: string | null };

const LUCIDE_PREFIX = 'morrow-icon:lucide:';
const FILE_PREFIX = 'morrow-icon:file:';
const SAFE_LUCIDE_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const SAFE_FILE_ID = /^(?:[A-Za-z0-9_-]{1,64}|attachments\/[A-Za-z0-9_. -]{1,120})$/;
const HEX_COLOR = /^#[\da-f]{6}$/i;

export function normalizeIconColor(color: unknown): string | null {
  return typeof color === 'string' && HEX_COLOR.test(color) ? color.toUpperCase() : null;
}

export function encodeLucideIcon(name: string, color: string | null = null): string | null {
  if (!SAFE_LUCIDE_NAME.test(name)) return null;
  return `${LUCIDE_PREFIX}${name}${normalizeIconColor(color) ? `|${normalizeIconColor(color)}` : ''}`;
}

export function encodeFileIcon(id: string, color: string | null = null): string | null {
  if (!SAFE_FILE_ID.test(id) || id.includes('..')) return null;
  return `${FILE_PREFIX}${encodeURIComponent(id)}${normalizeIconColor(color) ? `|${normalizeIconColor(color)}` : ''}`;
}

export function parsePageIcon(value: string | null | undefined): PageIcon | null {
  if (!value) return null;
  if (value.startsWith(LUCIDE_PREFIX)) {
    const match = /^morrow-icon:lucide:([A-Z][A-Za-z0-9]{0,63})(?:\|(#[\da-f]{6}))?$/i.exec(value);
    if (!match || !SAFE_LUCIDE_NAME.test(match[1]!)) return null;
    return { kind: 'lucide', name: match[1]!, color: normalizeIconColor(match[2]) };
  }
  if (value.startsWith(FILE_PREFIX)) {
    const match = /^morrow-icon:file:([^|]+)(?:\|(#[\da-f]{6}))?$/i.exec(value);
    if (!match) return null;
    let id: string;
    try {
      id = decodeURIComponent(match[1]!);
    } catch {
      return null;
    }
    if (!SAFE_FILE_ID.test(id) || id.includes('..')) return null;
    return { kind: 'file', id, color: normalizeIconColor(match[2]) };
  }
  if ([...value].length > 16) return null;
  return { kind: 'emoji', value };
}

export function validPageIcon(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ICON_LENGTH) return false;
  return parsePageIcon(value) !== null;
}

const SAFE_SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
]);

const SAFE_SVG_ATTRIBUTES = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'fill-rule',
  'clip-rule',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'transform',
  'id',
  'clip-path',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientUnits',
  'gradientTransform',
]);

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
const NUMBER_LIST = /^[-+\d.eE,\s]+$/;
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// SVG uploads are reduced to static geometry. Scripts, references, styles, links, and unknown XML
// constructs are rejected, so the result is safe to place inline and can use currentColor.
export function sanitizeSvg(source: string, color: string | null = null): string | null {
  if (!source || source.length > 1_000_000) return null;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
  }
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|image|use|iframe)\b/i.test(source)) return null;

  const xml = source.trim().replace(/^<\?xml\s+[^?]*\?>\s*/i, '');
  const stack: string[] = [];
  const output: string[] = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;
  const hasStroke = /(?:^|\s)stroke\s*=\s*["'](?!none["'])[^"']+["']/i.test(xml);

  while (cursor < xml.length) {
    const open = xml.indexOf('<', cursor);
    if (open < 0) {
      if (xml.slice(cursor).trim()) return null;
      break;
    }
    if (xml.slice(cursor, open).trim()) return null;
    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end < 0) return null;
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) return null;

    let end = open + 1;
    let quote = '';
    for (; end < xml.length; end++) {
      const char = xml[end]!;
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end >= xml.length || quote) return null;

    const token = xml.slice(open + 1, end).trim();
    cursor = end + 1;
    if (token.startsWith('/')) {
      const name = token.slice(1).trim();
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name) || stack.pop() !== name) return null;
      output.push(`</${name}>`);
      if (name === 'svg' && stack.length === 0) rootClosed = true;
      continue;
    }

    const selfClosing = token.endsWith('/');
    const body = selfClosing ? token.slice(0, -1).trimEnd() : token;
    const nameMatch = /^([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/.exec(body);
    if (!nameMatch) return null;
    const name = nameMatch[1]!;
    if (!SAFE_SVG_TAGS.has(name) || rootClosed) return null;
    if (!rootSeen && name !== 'svg') return null;
    if (name === 'svg') {
      if (rootSeen || stack.length) return null;
      rootSeen = true;
    } else if (!stack.length) return null;

    const attrs = parseSvgAttributes(nameMatch[2]!);
    if (!attrs) return null;
    if (name === 'svg') {
      if (!attrs.has('xmlns')) attrs.set('xmlns', SVG_NAMESPACE);
      if (color) {
        attrs.set('fill', hasStroke ? 'none' : 'currentColor');
        if (hasStroke) attrs.set('stroke', 'currentColor');
      }
    }
    if (color) {
      for (const key of ['fill', 'stroke', 'stop-color']) {
        const value = attrs.get(key);
        if (value && value !== 'none' && !value.startsWith('url(')) attrs.set(key, 'currentColor');
      }
    }

    const serialized = [...attrs].map(([key, value]) => ` ${key}="${escapeSvgAttribute(value)}"`).join('');
    output.push(`<${name}${serialized}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) stack.push(name);
    else if (name === 'svg') rootClosed = true;
  }

  if (!rootSeen || !rootClosed || stack.length !== 0) return null;
  return output.join('');
}

function parseSvgAttributes(source: string): Map<string, string> | null {
  const result = new Map<string, string>();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (cursor === source.length) break;
    const nameMatch = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(source.slice(cursor));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    cursor += name.length;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    if (source[cursor] !== '=') return null;
    cursor++;
    while (/\s/.test(source[cursor] ?? '')) cursor++;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") return null;
    const end = source.indexOf(quote, cursor + 1);
    if (end < 0) return null;
    const value = source.slice(cursor + 1, end);
    cursor = end + 1;
    if (/^on/i.test(name) || name === 'style' || name === 'href' || name === 'xlink:href') continue;
    if (!SAFE_SVG_ATTRIBUTES.has(name)) continue;
    const checked = safeSvgAttribute(name, value);
    if (checked === null) return null;
    result.set(name, checked);
  }
  return result;
}

function safeSvgAttribute(name: string, value: string): string | null {
  if (name === 'xmlns') return value === SVG_NAMESPACE ? value : null;
  if (name === 'viewBox') {
    const parts = value.trim().split(/[\s,]+/);
    return parts.length === 4 && parts.every((part) => NUMBER.test(part)) ? value : null;
  }
  if (['d'].includes(name)) return /^[MmLlHhVvCcSsQqTtAaZz0-9+\-.,\seE]+$/.test(value) ? value : null;
  if (name === 'points' || name === 'stroke-dasharray') return NUMBER_LIST.test(value) ? value : null;
  if (
    [
      'width',
      'height',
      'x',
      'y',
      'x1',
      'y1',
      'x2',
      'y2',
      'cx',
      'cy',
      'r',
      'rx',
      'ry',
      'stroke-width',
      'stroke-miterlimit',
      'stroke-dashoffset',
    ].includes(name)
  )
    return NUMBER.test(value) || /^\d+(?:\.\d+)?%$/.test(value) ? value : null;
  if (['opacity', 'fill-opacity', 'stroke-opacity', 'stop-opacity'].includes(name))
    return NUMBER.test(value) && Number(value) >= 0 && Number(value) <= 1 ? value : null;
  if (['fill', 'stroke', 'stop-color'].includes(name))
    return /^(?:none|currentColor|[A-Za-z]+|#[\da-f]{3,8}|url\(#[A-Za-z][\w.:-]*\))$/i.test(value)
      ? value
      : null;
  if (name === 'stroke-linecap') return /^(?:butt|round|square)$/i.test(value) ? value : null;
  if (name === 'stroke-linejoin') return /^(?:miter|round|bevel)$/i.test(value) ? value : null;
  if (name === 'fill-rule' || name === 'clip-rule')
    return /^(?:nonzero|evenodd)$/i.test(value) ? value : null;
  if (name === 'transform' || name === 'gradientTransform')
    return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+\d.eE,\s]+\)\s*)+$/i.test(value)
      ? value
      : null;
  if (name === 'id') return /^[A-Za-z][A-Za-z0-9_.:-]{0,100}$/.test(value) ? value : null;
  if (name === 'clip-path') return /^url\(#[A-Za-z][\w.:-]*\)$/.test(value) ? value : null;
  if (name === 'offset') return NUMBER.test(value) || /^\d+(?:\.\d+)?%$/.test(value) ? value : null;
  if (name === 'gradientUnits') return /^(?:userSpaceOnUse|objectBoundingBox)$/.test(value) ? value : null;
  return null;
}

function escapeSvgAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
