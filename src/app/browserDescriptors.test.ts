import { describe, expect, it } from 'vitest';
import { parseBrowserDescriptor } from './browserDescriptors';

describe('Google web file descriptors', () => {
  it('opens only a bounded JSON URL matching the descriptor extension', () => {
    const documentUrl = 'https://docs.google.com/document/d/synthetic-document/edit';
    const spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/synthetic-sheet/edit?gid=0';
    expect(parseBrowserDescriptor('gdoc', JSON.stringify({ url: documentUrl, resource_id: 'synthetic' }))).toEqual({
      ok: true,
      url: documentUrl,
    });
    expect(parseBrowserDescriptor('gsheet', JSON.stringify({ url: spreadsheetUrl }))).toEqual({
      ok: true,
      url: spreadsheetUrl,
    });
    expect(parseBrowserDescriptor('gdoc', JSON.stringify({ url: spreadsheetUrl }))).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
  });

  it('requires the standard HTTPS endpoint for Google document descriptors', () => {
    const documentUrl = 'https://docs.google.com/document/d/synthetic-document/edit';
    const spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/synthetic-sheet/edit';
    const defaultPortDocumentUrl = 'https://docs.google.com:443/document/d/synthetic-document/edit';
    expect(parseBrowserDescriptor('gdoc', JSON.stringify({ url: defaultPortDocumentUrl }))).toEqual({
      ok: true,
      url: documentUrl,
    });
    expect(
      parseBrowserDescriptor(
        'gdoc',
        JSON.stringify({ url: 'https://docs.google.com:8443/document/d/synthetic-document/edit' }),
      ),
    ).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
    expect(
      parseBrowserDescriptor(
        'gsheet',
        JSON.stringify({ url: 'https://docs.google.com:8443/spreadsheets/d/synthetic-sheet/edit' }),
      ),
    ).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
    expect(parseBrowserDescriptor('gsheet', JSON.stringify({ url: spreadsheetUrl }))).toEqual({
      ok: true,
      url: spreadsheetUrl,
    });
  });

  it('rejects malformed, oversized, credentialed, local, and mismatched descriptors', () => {
    for (const value of [
      '{',
      JSON.stringify({ url: 'file:///C:/synthetic' }),
      JSON.stringify({ url: 'https://user:pass@docs.google.com/document/d/x' }),
      JSON.stringify({ url: 'https://example.com/document/d/x' }),
      JSON.stringify({ url: 'https://docs.google.com/document/d/' }),
    ])
      expect(parseBrowserDescriptor('gdoc', value)).toEqual({ ok: false, code: 'invalid-resource' });
    expect(parseBrowserDescriptor('gdoc', `${' '.repeat(64 * 1024 + 1)}`)).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
  });
});
