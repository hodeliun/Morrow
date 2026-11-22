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
const SUPPORTED_HEX_BACKGROUND_ANCESTORS = new Set(['doc', 'columns', 'column', 'blockquote']);

/** Shared owner-chain rule used by parsing, serialization, and editor transaction validation. */
export function supportsHexBlockBackgroundOwner(
  ownerType: string,
  ancestorTypes: readonly string[],
): boolean {
  return (
    SUPPORTED_HEX_BACKGROUND_OWNERS.has(ownerType) &&
    ancestorTypes.every((ancestor) => SUPPORTED_HEX_BACKGROUND_ANCESTORS.has(ancestor))
  );
}
