export const MAX_BROWSER_ADDRESS_LENGTH = 8192;
export const MAX_BROWSER_TARGET_LENGTH = 8192;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const BLOCKED_SCHEME_PORT_PREFIX = /^(?:javascript|file|data):/iu;
function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export type BrowserUrlDecision =
  | {
      readonly ok: true;
      readonly url: string;
      readonly canRestore: boolean;
      readonly warnings: readonly ('http' | 'ephemeral')[];
    }
  | { readonly ok: false; readonly code: 'invalid-url' | 'url-too-long' };

function hasCredentialAuthority(value: string): boolean {
  const authorityStart = value.indexOf('://') + 3;
  const remainder = value.slice(authorityStart);
  const delimiter = remainder.search(/[/?#]/u);
  const authority = delimiter < 0 ? remainder : remainder.slice(0, delimiter);
  return authority.length === 0 || authority.includes('@');
}

function exactRestorableYoutubeUrl(url: URL, raw: string): boolean {
  return (
    url.protocol === 'https:' &&
    YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) &&
    url.port === '' &&
    url.pathname === '/watch' &&
    !url.hash &&
    !raw.includes('#') &&
    /^\?v=[A-Za-z0-9_-]{11}$/u.test(url.search) &&
    YOUTUBE_VIDEO_ID.test(url.search.slice(3))
  );
}

function looksLikeHostPort(value: string): boolean {
  const authority = value.split(/[/?#]/u, 1)[0] ?? '';
  return /^(?:\[[\da-f:.]+\]|[a-z\d.-]+):\d+$/iu.test(authority);
}

function fitsRestorableTarget(url: string): boolean {
  return '#/url/'.length + encodeURIComponent(url).length <= MAX_BROWSER_TARGET_LENGTH;
}

export function classifyBrowserUrl(value: unknown): BrowserUrlDecision {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    return { ok: false, code: 'invalid-url' };
  if (value.length > MAX_BROWSER_ADDRESS_LENGTH) return { ok: false, code: 'url-too-long' };
  if (BLOCKED_SCHEME_PORT_PREFIX.test(value)) return { ok: false, code: 'invalid-url' };

  const hasHttpScheme = /^https?:\/\//iu.test(value);
  const hasExplicitScheme = /^[a-z][a-z\d+.-]*:/iu.test(value);
  const raw = hasHttpScheme
    ? value
    : looksLikeHostPort(value)
      ? `https://${value}`
      : hasExplicitScheme
        ? value
        : `https://${value}`;
  if (raw.length > MAX_BROWSER_ADDRESS_LENGTH) return { ok: false, code: 'url-too-long' };
  if (!/^https?:\/\//iu.test(raw) || containsControlCharacters(raw) || raw.includes('\\'))
    return { ok: false, code: 'invalid-url' };
  if (/%(?![\da-f]{2})/iu.test(raw) || /%(?:0[\da-f]|1[\da-f]|7f|3f|23)/iu.test(raw))
    return { ok: false, code: 'invalid-url' };

  let parsed: URL;
  try {
    parsed = new URL(raw);
    if (containsControlCharacters(decodeURIComponent(raw))) return { ok: false, code: 'invalid-url' };
  } catch {
    return { ok: false, code: 'invalid-url' };
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    hasCredentialAuthority(raw)
  )
    return { ok: false, code: 'invalid-url' };

  const hasQueryOrFragment = parsed.search.length > 0 || parsed.hash.length > 0 || raw.includes('?') || raw.includes('#');
  const canRestore =
    (!hasQueryOrFragment || exactRestorableYoutubeUrl(parsed, raw)) && fitsRestorableTarget(parsed.href);
  const warnings: Array<'http' | 'ephemeral'> = [];
  if (parsed.protocol === 'http:') warnings.push('http');
  if (!canRestore) warnings.push('ephemeral');
  return {
    ok: true,
    url: parsed.href,
    canRestore,
    warnings,
  };
}

export function isAllowedBrowserDocumentUrl(value: unknown): boolean {
  return classifyBrowserUrl(value).ok;
}

export function isAllowedBrowserRequestUrl(value: unknown, resourceType: string): boolean {
  if (typeof value !== 'string' || value.length > MAX_BROWSER_ADDRESS_LENGTH * 4 || containsControlCharacters(value))
    return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:')
    return Boolean(url.hostname) && !url.username && !url.password && !hasCredentialAuthority(value);

  const frame = resourceType === 'mainFrame' || resourceType === 'subFrame';
  if (frame) return false;
  if (url.protocol === 'blob:') return url.origin.startsWith('http://') || url.origin.startsWith('https://');
  if (url.protocol === 'data:') return resourceType === 'image' || resourceType === 'font';
  return false;
}

export interface BrowserRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function clampBrowserRect(rect: BrowserRect, content: { width: number; height: number }): BrowserRect {
  const x = Number.isFinite(rect.x) ? Math.max(0, Math.min(content.width, rect.x)) : 0;
  const y = Number.isFinite(rect.y) ? Math.max(0, Math.min(content.height, rect.y)) : 0;
  const width = Number.isFinite(rect.width) ? Math.max(0, Math.min(content.width - x, rect.width)) : 0;
  const height = Number.isFinite(rect.height) ? Math.max(0, Math.min(content.height - y, rect.height)) : 0;
  return { x, y, width, height };
}
