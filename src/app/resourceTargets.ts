const URL_TARGET_PREFIX = '#/url/';
const MAX_SERIALIZED_TARGET_LENGTH = 8192;
export const URL_UNAVAILABLE_HASH = '#/url/invalid';

export type ResourceTarget =
  | { readonly kind: 'page'; readonly hash: string }
  | { readonly kind: 'file'; readonly hash: string }
  | { readonly kind: 'view'; readonly hash: string }
  | { readonly kind: 'url'; readonly url: string | null }
  | { readonly kind: 'empty' };

function invalidUrlTarget(): ResourceTarget {
  return { kind: 'url', url: null };
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

export function normalizeSafeHttpUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    containsControlCharacter(value) ||
    /%(?![\da-f]{2})/iu.test(value) ||
    /%(?:0[\da-f]|1[\da-f]|7f|3f|23)/iu.test(value) ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    !/^https?:\/\//iu.test(value)
  )
    return null;

  let decodedValue: string;
  try {
    decodedValue = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (containsControlCharacter(decodedValue)) return null;

  const authorityStart = value.indexOf('://') + 3;
  const remainder = value.slice(authorityStart);
  const delimiter = remainder.search(/[/?#]/u);
  const authority = delimiter < 0 ? remainder : remainder.slice(0, delimiter);
  if (!authority || authority.includes('@')) return null;

  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    const normalized = url.href;
    return URL_TARGET_PREFIX.length + encodeURIComponent(normalized).length <= MAX_SERIALIZED_TARGET_LENGTH
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function parseResourceTarget(serialized: string | null): ResourceTarget {
  if (serialized === null || serialized === '') return { kind: 'empty' };

  if (
    serialized === '#/url' ||
    serialized.startsWith('#/url/') ||
    serialized.startsWith('#/url?') ||
    serialized.startsWith('#/url#')
  ) {
    if (serialized.length > MAX_SERIALIZED_TARGET_LENGTH || !serialized.startsWith(URL_TARGET_PREFIX))
      return invalidUrlTarget();
    const encodedUrl = serialized.slice(URL_TARGET_PREFIX.length);
    if (!encodedUrl || encodedUrl.includes('/') || encodedUrl.includes('?') || encodedUrl.includes('#'))
      return invalidUrlTarget();
    try {
      return { kind: 'url', url: normalizeSafeHttpUrl(decodeURIComponent(encodedUrl)) };
    } catch {
      return invalidUrlTarget();
    }
  }

  if (serialized === '#/page' || serialized.startsWith('#/page/') || serialized.startsWith('#/page?'))
    return { kind: 'page', hash: serialized };
  if (serialized === '#/file' || serialized.startsWith('#/file/') || serialized.startsWith('#/file?'))
    return { kind: 'file', hash: serialized };
  return { kind: 'view', hash: serialized };
}

export function serializeResourceTarget(target: ResourceTarget): string | null {
  switch (target.kind) {
    case 'empty':
      return null;
    case 'url': {
      const url = normalizeSafeHttpUrl(target.url);
      if (!url) return null;
      const serialized = `${URL_TARGET_PREFIX}${encodeURIComponent(url)}`;
      return serialized.length <= MAX_SERIALIZED_TARGET_LENGTH ? serialized : null;
    }
    case 'page':
    case 'file':
    case 'view':
      return target.hash.length > 0 ? target.hash : null;
  }
}

export function canonicalizeResourceTargetHash(hash: string): string {
  const target = parseResourceTarget(hash);
  if (target.kind !== 'url') return hash;
  return serializeResourceTarget(target) ?? URL_UNAVAILABLE_HASH;
}
