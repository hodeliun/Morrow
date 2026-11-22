import { normalizeInlineColor } from '../model';
import type { InlineColor } from '../model';

const BLOCK_BACKGROUND_MARKER =
  /^<!-- morrow:block-background:(gray|brown|orange|yellow|green|blue|purple|pink|red|#[0-9a-fA-F]{6}) -->$/;

/** Reads only the standalone legacy marker form; custom hex values are normalized to lowercase. */
export function parseBlockBackgroundMarker(value: string): InlineColor | null {
  const match = BLOCK_BACKGROUND_MARKER.exec(value.trim());
  return match ? normalizeInlineColor(match[1]) : null;
}

/** Writes safe canonical marker text from a palette name or an exact six-digit hex value. */
export function formatBlockBackgroundMarker(value: unknown): string | null {
  const color = normalizeInlineColor(value);
  return color ? `<!-- morrow:block-background:${color} -->` : null;
}

export function isHexBlockBackground(value: unknown): value is `#${string}` {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/.test(value);
}

const SUPPORTED_HEX_BACKGROUND_OWNERS = new Set(['paragraph', 'heading', 'blockquote']);
const SUPPORTED_HEX_BACKGROUND_ANCESTORS = new Set([
  'doc',
  'columns',
  'column',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
]);
const SUPPORTED_LIST_ITEM_CONTAINERS = new Set(['bulletList', 'orderedList']);
const SUPPORTED_HEX_BACKGROUND_NON_LIST_ANCESTORS = new Set(['doc', 'columns', 'column', 'blockquote']);

/** Shared owner-chain rule used by parsing, serialization, and editor transaction validation. */
export function supportsHexBlockBackgroundOwner(
  ownerType: string,
  ancestorTypes: readonly string[],
  firstTaskItemParagraph = false,
): boolean {
  const parentType = ancestorTypes.at(-1);
  const listContainerType = ancestorTypes.at(-2);
  const directListParagraph =
    ownerType === 'paragraph' && (parentType === 'listItem' || parentType === 'taskItem');
  if (directListParagraph) {
    return (
      ((parentType === 'taskItem' && listContainerType === 'taskList') ||
        (parentType === 'listItem' && SUPPORTED_LIST_ITEM_CONTAINERS.has(listContainerType ?? ''))) &&
      !(parentType === 'taskItem' && firstTaskItemParagraph) &&
      ancestorTypes.every((ancestor) => SUPPORTED_HEX_BACKGROUND_ANCESTORS.has(ancestor))
    );
  }
  return (
    SUPPORTED_HEX_BACKGROUND_OWNERS.has(ownerType) &&
    ancestorTypes.every((ancestor) => SUPPORTED_HEX_BACKGROUND_NON_LIST_ANCESTORS.has(ancestor))
  );
}
