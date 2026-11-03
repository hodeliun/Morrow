import { describe, expect, it } from 'vitest';
import {
  canonicalizeResourceTargetHash,
  normalizeSafeHttpUrl,
  parseResourceTarget,
  serializeResourceTarget,
  URL_UNAVAILABLE_HASH,
} from './resourceTargets';

describe('resource target adapter', () => {
  it('distinguishes an empty pane from legacy page and file routes', () => {
    const pageHash = '#/page/synthetic%20page?anchor=Heading%20one';
    const fileHash =
      '#/file/4e56179b-70c7-49b2-ae96-913fe5e8fe9a/Images/%E8%97%9D%E8%A1%93%20%26%20maps/100%25%20complete%20%252F.png';

    expect(parseResourceTarget(null)).toEqual({ kind: 'empty' });
    expect(parseResourceTarget('')).toEqual({ kind: 'empty' });
    expect(serializeResourceTarget({ kind: 'empty' })).toBeNull();
    expect(serializeResourceTarget({ kind: 'view', hash: '' })).toBeNull();

    const page = parseResourceTarget(pageHash);
    const file = parseResourceTarget(fileHash);
    expect(page).toEqual({ kind: 'page', hash: pageHash });
    expect(file).toEqual({ kind: 'file', hash: fileHash });
    expect(serializeResourceTarget(page)).toBe(pageHash);
    expect(serializeResourceTarget(file)).toBe(fileHash);
    expect(serializeResourceTarget(parseResourceTarget('#/search?q=synthetic'))).toBe('#/search?q=synthetic');
  });

  it('roundtrips only safe credential-free HTTP(S) URL targets', () => {
    const target = { kind: 'url' as const, url: 'HTTPS://example.com/synthetic%20path' };
    const serialized = serializeResourceTarget(target);

    expect(normalizeSafeHttpUrl(target.url)).toBe('https://example.com/synthetic%20path');
    expect(serialized).toBe('#/url/https%3A%2F%2Fexample.com%2Fsynthetic%2520path');
    expect(parseResourceTarget(serialized)).toEqual({
      kind: 'url',
      url: 'https://example.com/synthetic%20path',
    });
    expect(serializeResourceTarget(parseResourceTarget(serialized))).toBe(serialized);
  });

  it('canonicalizes only URL routes and replaces rejected URL values with a fixed typed fallback', () => {
    const safe = '#/url/https%3A%2F%2FEXAMPLE.com%2Fpath';
    expect(canonicalizeResourceTargetHash(safe)).toBe('#/url/https%3A%2F%2Fexample.com%2Fpath');
    expect(
      canonicalizeResourceTargetHash(
        `#/url/${encodeURIComponent('https://synthetic-user:synthetic-pass@example.invalid/path?token=synthetic-sentinel')}`,
      ),
    ).toBe(URL_UNAVAILABLE_HASH);
    expect(parseResourceTarget(URL_UNAVAILABLE_HASH)).toEqual({ kind: 'url', url: null });

    const legacyHashes = [
      '#/page/synthetic%20page?anchor=Heading%20one',
      '#/file/synthetic-root/Images/100%25.png?download=0',
      '#/search?q=synthetic&sort=recent',
    ];
    for (const hash of legacyHashes) expect(canonicalizeResourceTargetHash(hash)).toBe(hash);
  });

  it('roundtrips literal and percent-encoded UTF-8 path segments', () => {
    for (const url of ['https://example.com/藝術', 'https://example.com/%E8%97%9D%E8%A1%93']) {
      const serialized = serializeResourceTarget({ kind: 'url', url });
      expect(serialized).toBe('#/url/https%3A%2F%2Fexample.com%2F%25E8%2597%259D%25E8%25A1%2593');
      expect(parseResourceTarget(serialized)).toEqual({
        kind: 'url',
        url: 'https://example.com/%E8%97%9D%E8%A1%93',
      });
    }
  });

  it('keeps malformed or disallowed URL routes typed and unpersistable', () => {
    const unsafeUrls = [
      'javascript:alert(1)',
      'file:///tmp/synthetic.png',
      'data:text/plain,synthetic',
      'https://user:pass@example.com/path',
      'https://@example.com/path',
      'https://example.com/path?token=synthetic',
      'https://example.com/path#access-token',
      'https://example.com/path?',
      'https://example.com/path#',
      'https://example.com/%2',
      'https://example.com/%0A',
      'https://example.com/%C2%85',
      'https://example.com/%3Ftoken',
      'https://example.com/%23fragment',
      'https://example.com/line\nfeed',
      'https://example.com/\u0085',
      ' https://example.com/path',
      'https://example.com/%E0%A4',
    ];

    for (const url of unsafeUrls) {
      expect(normalizeSafeHttpUrl(url)).toBeNull();
      expect(serializeResourceTarget({ kind: 'url', url })).toBeNull();
      expect(parseResourceTarget(`#/url/${encodeURIComponent(url)}`)).toEqual({ kind: 'url', url: null });
    }
    expect(parseResourceTarget('#/url/%E0%A4%A')).toEqual({ kind: 'url', url: null });
    expect(parseResourceTarget('#/url#fragment')).toEqual({ kind: 'url', url: null });
    expect(parseResourceTarget('#/url/https%3A%2F%2Fexample.com%2Fpath?token=synthetic')).toEqual({
      kind: 'url',
      url: null,
    });
  });
});
