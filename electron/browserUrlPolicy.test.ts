import { describe, expect, it } from 'vitest';
import {
  clampBrowserRect,
  classifyBrowserUrl,
  isAllowedBrowserDocumentUrl,
  isAllowedBrowserRequestUrl,
} from './browserUrlPolicy.js';

describe('browser URL policy', () => {
  it('permits restorable clean URLs and only the exact YouTube watch query', () => {
    expect(classifyBrowserUrl('example.com')).toEqual({
      ok: true,
      url: 'https://example.com/',
      canRestore: true,
      warnings: [],
    });
    expect(classifyBrowserUrl('http://example.com/')).toMatchObject({
      ok: true,
      canRestore: true,
      warnings: ['http'],
    });
    expect(classifyBrowserUrl('https://youtube.com/watch?v=abcdefghijk')).toMatchObject({
      ok: true,
      canRestore: true,
      warnings: [],
    });
  });

  it('marks other query and fragment URLs ephemeral without stripping their runtime value', () => {
    const value = 'https://example.com/search?q=synthetic#result';
    expect(classifyBrowserUrl(value)).toEqual({
      ok: true,
      url: value,
      canRestore: false,
      warnings: ['ephemeral'],
    });
    for (const value of [
      'https://youtube.com/watch?v=abcdefghijk&list=synthetic',
      'https://youtube.com/watch?list=synthetic&v=abcdefghijk',
      'https://youtube.com/watch?v=short',
    ])
      expect(classifyBrowserUrl(value)).toMatchObject({ ok: true, canRestore: false, warnings: ['ephemeral'] });
  });

  it('completes validated host:port input without treating schemes as hosts and keeps warnings composable', () => {
    expect(classifyBrowserUrl('example.com:443')).toMatchObject({
      ok: true,
      url: 'https://example.com/',
      canRestore: true,
      warnings: [],
    });
    expect(classifyBrowserUrl('example.com:8443')).toMatchObject({
      ok: true,
      url: 'https://example.com:8443/',
      canRestore: true,
      warnings: [],
    });
    expect(classifyBrowserUrl('localhost:443')).toMatchObject({
      ok: true,
      url: 'https://localhost/',
      canRestore: true,
      warnings: [],
    });
    expect(classifyBrowserUrl('[::1]:8443')).toMatchObject({
      ok: true,
      url: 'https://[::1]:8443/',
      canRestore: true,
      warnings: [],
    });
    expect(classifyBrowserUrl('javascript:alert(1)')).toMatchObject({ ok: false, code: 'invalid-url' });
    expect(classifyBrowserUrl('https://youtube.com:8443/watch?v=abcdefghijk')).toMatchObject({
      ok: true,
      canRestore: false,
      warnings: ['ephemeral'],
    });
    expect(classifyBrowserUrl('http://example.com/?token=synthetic')).toMatchObject({
      ok: true,
      canRestore: false,
      warnings: ['http', 'ephemeral'],
    });

    const longUrl = `https://example.com/${'a'.repeat(5000)}`;
    expect(classifyBrowserUrl(longUrl)).toMatchObject({ ok: true, canRestore: true, warnings: [] });
    const addressAtLimit = `https://example.com/${'a'.repeat(8172)}`;
    expect(addressAtLimit).toHaveLength(8192);
    expect(classifyBrowserUrl(addressAtLimit)).toMatchObject({
      ok: true,
      canRestore: false,
      warnings: ['ephemeral'],
    });
  });

  it('rejects credentials, non-web schemes, controls, encoded delimiters, and oversized input', () => {
    for (const value of [
      'javascript:alert(1)',
      'javascript:443',
      'file:443',
      'data:443',
      'file:///synthetic.txt',
      'data:text/html,synthetic',
      'https://user:pass@example.com/',
      'https://@example.com/',
      'https://example.com/%3fsecret',
      'https://example.com/%C2%85',
      `https://example.com/${'a'.repeat(8192)}`,
    ])
      expect(classifyBrowserUrl(value).ok).toBe(false);
  });

  it('allows only HTTP(S) documents and network requests plus bounded web subresources', () => {
    for (const value of ['https://example.com/', 'http://example.com/?q=synthetic'])
      expect(isAllowedBrowserDocumentUrl(value)).toBe(true);
    for (const value of ['file:///synthetic.txt', 'morrow-file://vault/a.md', 'javascript:alert(1)', 'data:text/html,hi'])
      expect(isAllowedBrowserDocumentUrl(value)).toBe(false);

    expect(isAllowedBrowserRequestUrl('https://example.com/script.js', 'script')).toBe(true);
    expect(isAllowedBrowserRequestUrl('blob:https://example.com/synthetic', 'media')).toBe(true);
    expect(isAllowedBrowserRequestUrl('data:image/png;base64,AA==', 'image')).toBe(true);
    expect(isAllowedBrowserRequestUrl('data:text/html,synthetic', 'mainFrame')).toBe(false);
    expect(isAllowedBrowserRequestUrl('file:///synthetic.txt', 'other')).toBe(false);
    expect(isAllowedBrowserRequestUrl('morrow-file://vault/synthetic', 'image')).toBe(false);
  });

  it('clamps pane bounds to the native content rectangle and rejects non-finite dimensions', () => {
    expect(clampBrowserRect({ x: 80, y: -4, width: 80, height: Number.NaN }, { width: 100, height: 70 })).toEqual({
      x: 80,
      y: 0,
      width: 20,
      height: 0,
    });
  });
});
