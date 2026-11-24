export interface ParsedHtmlTag {
  name: string;
  attributes: Array<{ name: string; value: string | null }>;
  selfClosing: boolean;
}

/** Parses the attributes of one complete HTML tag without matching names inside quoted values. */
export function parseHtmlTag(tag: string): ParsedHtmlTag | null {
  if (!tag.startsWith('<') || !tag.endsWith('>') || /^<\//.test(tag)) return null;

  let cursor = 1;
  const nameStart = cursor;
  while (cursor < tag.length - 1 && /[A-Za-z0-9:-]/.test(tag[cursor]!)) cursor++;
  if (cursor === nameStart || !/[A-Za-z]/.test(tag[nameStart]!)) return null;

  const name = tag.slice(nameStart, cursor).toLowerCase();
  const attributes: ParsedHtmlTag['attributes'] = [];
  let selfClosing = false;
  while (cursor < tag.length - 1) {
    while (cursor < tag.length - 1 && /\s/.test(tag[cursor]!)) cursor++;
    if (cursor >= tag.length - 1) break;
    if (tag[cursor] === '/') {
      selfClosing = true;
      cursor++;
      while (cursor < tag.length - 1 && /\s/.test(tag[cursor]!)) cursor++;
      if (cursor !== tag.length - 1) return null;
      break;
    }

    const attributeStart = cursor;
    while (cursor < tag.length - 1 && !/[\s="'<>/]/.test(tag[cursor]!)) cursor++;
    if (cursor === attributeStart) return null;
    const attributeName = tag.slice(attributeStart, cursor).toLowerCase();
    while (cursor < tag.length - 1 && /\s/.test(tag[cursor]!)) cursor++;

    let value: string | null = null;
    if (tag[cursor] === '=') {
      cursor++;
      while (cursor < tag.length - 1 && /\s/.test(tag[cursor]!)) cursor++;
      if (cursor >= tag.length - 1) return null;
      const quote = tag[cursor] === '"' || tag[cursor] === "'" ? tag[cursor]! : null;
      if (quote) {
        cursor++;
        const valueStart = cursor;
        while (cursor < tag.length - 1 && tag[cursor] !== quote) cursor++;
        if (cursor >= tag.length - 1) return null;
        value = tag.slice(valueStart, cursor);
        cursor++;
        if (cursor < tag.length - 1 && !/[\s/]/.test(tag[cursor]!)) return null;
      } else {
        const valueStart = cursor;
        while (cursor < tag.length - 1 && !/[\s>]/.test(tag[cursor]!)) {
          if (/["'`<=]/.test(tag[cursor]!)) return null;
          cursor++;
        }
        if (cursor === valueStart) return null;
        value = tag.slice(valueStart, cursor);
      }
    }
    attributes.push({ name: attributeName, value });
  }

  return { name, attributes, selfClosing };
}

/** Parses the narrow numeric grammar used by the published equal-width column extension. */
export function parseLegacyColumnWidths(value: unknown, expectedCount?: number): number[] | null {
  if (typeof value !== 'string' || value.length > 96) return null;
  const parts = value.split(',');
  if (parts.length < 2 || parts.length > 7 || (expectedCount !== undefined && parts.length !== expectedCount)) {
    return null;
  }

  const widths: number[] = [];
  for (const part of parts) {
    if (!/^[\t ]*\d+(?:\.\d{1,2})?[\t ]*$/.test(part)) return null;
    const width = Number(part);
    if (!Number.isFinite(width) || width <= 0 || width > 1000) return null;
    widths.push(width);
  }
  return widths;
}

export function parseColumnLayoutTag(
  tag: string,
): { kind: 'columns'; widths: string | null } | { kind: 'column' } | { kind: 'close' } | null {
  if (/^<\/div>$/i.test(tag)) return { kind: 'close' };
  if (tag.toLowerCase() === '<div data-column>') return { kind: 'column' };
  if (tag.toLowerCase() === '<div data-columns>') return { kind: 'columns', widths: null };

  const parsed = parseHtmlTag(tag);
  if (!parsed || parsed.name !== 'div' || parsed.selfClosing) return null;
  const attributes = parsed.attributes;
  if (new Set(attributes.map((attribute) => attribute.name)).size !== attributes.length) return null;
  const columns = attributes.filter((attribute) => attribute.name === 'data-columns');
  const widths = attributes.filter((attribute) => attribute.name === 'data-widths');
  if (
    columns.length !== 1 ||
    columns[0]!.value !== null ||
    widths.length !== 1 ||
    widths[0]!.value === null ||
    attributes.length !== 2 ||
    parseLegacyColumnWidths(widths[0]!.value) === null
  ) {
    return null;
  }
  return { kind: 'columns', widths: widths[0]!.value };
}

export function legacyColumnGridTemplate(value: unknown, expectedCount: number): string | null {
  const widths = parseLegacyColumnWidths(value, expectedCount);
  return widths ? widths.map((width) => `minmax(0, ${width}fr)`).join(' ') : null;
}
