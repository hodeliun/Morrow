import { classifyBrowserAddress } from './resourceTargets';

const MAX_DESCRIPTOR_LENGTH = 64 * 1024;

export type BrowserDescriptorResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: 'invalid-resource' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBrowserDescriptor(extension: unknown, contents: unknown): BrowserDescriptorResult {
  if (
    (extension !== 'gdoc' && extension !== 'gsheet') ||
    typeof contents !== 'string' ||
    contents.length === 0 ||
    contents.length > MAX_DESCRIPTOR_LENGTH
  )
    return { ok: false, code: 'invalid-resource' };

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    return { ok: false, code: 'invalid-resource' };
  }
  if (!isRecord(value) || typeof value.url !== 'string') return { ok: false, code: 'invalid-resource' };

  const address = classifyBrowserAddress(value.url);
  if (!address.ok || !isMatchingGoogleDocumentUrl(extension, address.url))
    return { ok: false, code: 'invalid-resource' };
  return { ok: true, url: address.url };
}

function isMatchingGoogleDocumentUrl(extension: 'gdoc' | 'gsheet', value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'docs.google.com' || url.port !== '') return false;
    const expectedPath = extension === 'gdoc' ? /^\/document\/d\/[A-Za-z0-9_-]+(?:\/|$)/u : /^\/spreadsheets\/d\/[A-Za-z0-9_-]+(?:\/|$)/u;
    return expectedPath.test(url.pathname);
  } catch {
    return false;
  }
}
