import { describe, expect, it } from 'vitest';
import { parseRoute, routeHash } from './router';

const VAULT_ID = '4e56179b-70c7-49b2-ae96-913fe5e8fe9a';

describe('file routes', () => {
  it('roundtrips Unicode, spaces, and literal percent sequences by encoding each path segment once', () => {
    const route = {
      name: 'file' as const,
      vaultId: VAULT_ID,
      path: 'Images/藝術 & maps/100% complete %2F.png',
    };
    const hash = routeHash(route);
    expect(hash).toBe(
      '#/file/4e56179b-70c7-49b2-ae96-913fe5e8fe9a/Images/%E8%97%9D%E8%A1%93%20%26%20maps/100%25%20complete%20%252F.png',
    );
    expect(parseRoute(hash)).toEqual(route);
  });

  it('fails closed for malformed escapes, encoded separators, traversal, and route queries', () => {
    for (const hash of [
      `#/file/${VAULT_ID}/bad%.png`,
      `#/file/${VAULT_ID}/folder%2Fimage.png`,
      `#/file/${VAULT_ID}/%2e%2e/secret.png`,
      `#/file/${VAULT_ID}/folder/../secret.png`,
      `#/file/${VAULT_ID}/folder/image.png?path=../../outside.png`,
      `#//file/${VAULT_ID}/image.png`,
      '#/file/not-a-vault-id/image.png',
    ]) {
      expect(parseRoute(hash)).toEqual({ name: 'file', vaultId: null, path: null });
    }
  });

  it('does not decode a literal percent escape twice', () => {
    const hash = `#/file/${VAULT_ID}/Images/%252e%252e.png`;
    const parsed = parseRoute(hash);
    expect(parsed).toEqual({ name: 'file', vaultId: VAULT_ID, path: 'Images/%2e%2e.png' });
    expect(routeHash(parsed)).toBe(hash);
  });

  it('preserves existing page routes', () => {
    expect(parseRoute('#/page/synthetic-page')).toMatchObject({ name: 'page', id: 'synthetic-page' });
    expect(routeHash({ name: 'home' })).toBe('#/');
  });
});

describe('unavailable URL routes', () => {
  it('roundtrips a credential-free HTTP(S) address as a typed URL target', () => {
    const route = { name: 'url' as const, url: 'https://example.com/synthetic%20path' };
    const hash = routeHash(route);

    expect(hash).toBe('#/url/https%3A%2F%2Fexample.com%2Fsynthetic%2520path');
    expect(parseRoute(hash)).toEqual(route);
  });

  it('keeps malformed, credentialed, query, fragment and privileged targets unavailable', () => {
    for (const url of [
      'javascript:alert(1)',
      'file:///tmp/synthetic.png',
      'https://user:pass@example.com/path',
      'https://example.com/path?token=synthetic',
      'https://example.com/path#synthetic',
    ]) {
      const hash = routeHash({ name: 'url', url });
      expect(hash).toBe('#/url/invalid');
      expect(parseRoute(hash)).toEqual({ name: 'url', url: null });
    }
    expect(parseRoute('#/url/%E0%A4%A')).toEqual({ name: 'url', url: null });
    expect(parseRoute('#/url#fragment')).toEqual({ name: 'url', url: null });
    expect(parseRoute('#/url/https%3A%2F%2Fexample.com%2Fpath?token=synthetic')).toEqual({
      name: 'url',
      url: null,
    });
  });
});
