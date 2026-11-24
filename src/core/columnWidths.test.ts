import { describe, expect, it } from 'vitest';
import { legacyColumnGridTemplate, parseColumnLayoutTag, parseLegacyColumnWidths } from './columnWidths';

describe('legacy equal-width column metadata', () => {
  it('validates published width lists without changing their lexical form', () => {
    const examples = [
      '14.1,14.1,14.1,14.1,14.1,14.7,14.8',
      '020.00, 080.00',
      '\t020.00,\t080.00\t',
      '50.05,49.95',
    ];
    for (const value of examples) {
      expect(parseLegacyColumnWidths(value)).not.toBeNull();
    }
    expect(parseLegacyColumnWidths('020.00, 080.00', 2)).toEqual([20, 80]);
    expect(legacyColumnGridTemplate('50.05,49.95', 2)).toBe('minmax(0, 50.05fr) minmax(0, 49.95fr)');
  });

  it('rejects malformed, zero, over-limit, over-precision and overlong lists', () => {
    const invalid = [
      '',
      '50',
      '50,0',
      '50,-1',
      '50,+1',
      '50,1000.01',
      '50,1001',
      '50,49.999',
      '50,\n50',
      '50,\r\n50',
      '50,,50',
      `${' '.repeat(94)}1,1`,
    ];
    for (const value of invalid) expect(parseLegacyColumnWidths(value)).toBeNull();
    expect(parseLegacyColumnWidths('50,50', 3)).toBeNull();
    expect(parseLegacyColumnWidths(`${' '.repeat(93)}1,1`)).toEqual([1, 1]);
  });

  it('recognizes only a bare group or a group with one valid widths attribute', () => {
    expect(parseColumnLayoutTag('<div data-columns>')).toEqual({ kind: 'columns', widths: null });
    expect(parseColumnLayoutTag('<div data-columns data-widths="020.00, 080.00">')).toEqual({
      kind: 'columns',
      widths: '020.00, 080.00',
    });
    for (const tag of [
      '<div data-columns class="future" data-widths="50,50">',
      '<div data-columns data-widths="50,50" data-widths="50,50">',
      '<div data-columns data-widths="50,0">',
      '<div data-columns data-widths="50,\r\n50">',
      '<div data-column data-widths="50,50">',
      '<div data-columns data-widths="50,50" data-block-id="opaque">',
      '<div data-columns data-widths="50,50" />',
    ]) {
      expect(parseColumnLayoutTag(tag), tag).toBeNull();
    }
  });
});
