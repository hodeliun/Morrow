import {
  classifyBrowserUrl,
  MAX_BROWSER_TARGET_LENGTH,
} from '../../electron/browserUrlPolicy';

const URL_TARGET_PREFIX = '#/url/';
const MAX_SERIALIZED_TARGET_LENGTH = MAX_BROWSER_TARGET_LENGTH;
export const URL_UNAVAILABLE_HASH = '#/url/invalid';

export type ResourceTarget =
  | { readonly kind: 'page'; readonly hash: string }
  | { readonly kind: 'file'; readonly hash: string }
  | { readonly kind: 'view'; readonly hash: string }
  | { readonly kind: 'url'; readonly url: string | null }
  | { readonly kind: 'empty' };

export type BrowserAddressDecision =
  | {
      readonly ok: true;
      readonly url: string;
      readonly restorable: boolean;
      readonly warnings: readonly ('http' | 'ephemeral')[];
    }
  | { readonly ok: false; readonly code: 'invalid-url' | 'url-too-long' };

function invalidUrlTarget(): ResourceTarget {
  return { kind: 'url', url: null };
}

export function normalizeSafeHttpUrl(value: unknown): string | null {
  const decision = classifyBrowserUrl(value);
  return decision.ok && decision.canRestore ? decision.url : null;
}

export function classifyBrowserAddress(value: unknown): BrowserAddressDecision {
  const decision = classifyBrowserUrl(value);
  return decision.ok
    ? {
        ok: true,
        url: decision.url,
        restorable: decision.canRestore,
        warnings: decision.warnings,
      }
    : decision;
}

export function parseResourceTarget(serialized: string | null): ResourceTarget {
  if (serialized === null || serialized === '') return { kind: 'empty' };
  if (serialized === URL_UNAVAILABLE_HASH) return invalidUrlTarget();

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
