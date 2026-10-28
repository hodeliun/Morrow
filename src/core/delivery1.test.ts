import { describe, expect, test } from 'vitest';
import {
  MAX_PAGE_COLUMNS,
  validBlockBackground,
  formatImageCrop,
  parseImageCrop,
  validImageCrop,
  parseColumnWidths,
  formatColumnWidths,
} from './model';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';

describe('Delivery 1: Core interaction models & round trip', () => {
  describe('Ticket #27: Block backgrounds with hex colors', () => {
    test('validBlockBackground accepts hex and standard color names', () => {
      expect(validBlockBackground('yellow')).toBe('yellow');
      expect(validBlockBackground('#2f80ed')).toBe('#2f80ed');
      expect(validBlockBackground('#123456')).toBe('#123456');
      expect(validBlockBackground('invalid-color')).toBeNull();
      expect(validBlockBackground('#XYZ123')).toBeNull();
    });

    test('preserves hex background across markdown serialize and parse', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { blockBackground: '#2f80ed' },
            content: [{ type: 'text', text: 'Colored block text' }],
          },
        ],
      };
      const md = docToMarkdown(doc);
      expect(md).toContain('<!-- morrow:block-background:#2f80ed -->');
      const roundTrip = markdownToDoc(md);
      expect(roundTrip.content?.[0]?.attrs?.blockBackground).toBe('#2f80ed');
      expect(roundTrip.content?.[0]?.content?.[0]?.text).toBe('Colored block text');
    });
  });

  describe('Ticket #30: Image alignment, caption, and non-destructive crop', () => {
    test('crop validation and formatting roundtrip', () => {
      const crop = { x: 0.1, y: 0.15, width: 0.8, height: 0.7 };
      expect(validImageCrop(crop)).toEqual(crop);
      const formatted = formatImageCrop(crop);
      expect(formatted).toBe('0.1,0.15,0.8,0.7');
      expect(parseImageCrop(formatted)).toEqual(crop);
    });

    test('invalid crop coordinates are rejected safely', () => {
      expect(validImageCrop({ x: -0.1, y: 0, width: 0.5, height: 0.5 })).toBeNull();
      expect(validImageCrop({ x: 0.5, y: 0.5, width: 0.6, height: 0.5 })).toBeNull(); // exceeds 1
      expect(validImageCrop(null)).toBeNull();
      expect(parseImageCrop('invalid,string')).toBeNull();
    });

    test('image metadata persists in markdown round-trip', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'sample.png',
              alt: 'Sample Image',
              align: 'right',
              caption: 'A descriptive caption',
              crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
            },
          },
        ],
      };
      const md = docToMarkdown(doc);
      expect(md).toContain('<!-- morrow:image align="right" caption="A descriptive caption" crop="0.05,0.05,0.9,0.9" -->');
      const roundTrip = markdownToDoc(md);
      const img = roundTrip.content?.[0];
      expect(img?.type).toBe('image');
      expect(img?.attrs?.align).toBe('right');
      expect(img?.attrs?.caption).toBe('A descriptive caption');
      expect(img?.attrs?.crop).toEqual({ x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
    });
  });

  describe('Ticket #31: Collapsible headings', () => {
    test('collapsible and collapsed heading state serializes and parses properly', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2, collapsible: true, collapsed: true },
            content: [{ type: 'text', text: 'Collapsible Section' }],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Hidden content inside folded section' }],
          },
        ],
      };
      const md = docToMarkdown(doc);
      expect(md).toContain('<!-- morrow:heading collapsible collapsed -->');
      const roundTrip = markdownToDoc(md);
      const h2 = roundTrip.content?.[0];
      expect(h2?.type).toBe('heading');
      expect(h2?.attrs?.collapsible).toBe(true);
      expect(h2?.attrs?.collapsed).toBe(true);
      expect(h2?.content?.[0]?.text).toBe('Collapsible Section');
    });

    test('collapsible uncollapsed heading preserves collapsible flag', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1, collapsible: true, collapsed: false },
            content: [{ type: 'text', text: 'Expanded Section' }],
          },
        ],
      };
      const md = docToMarkdown(doc);
      expect(md).toContain('<!-- morrow:heading collapsible -->');
      expect(md).not.toContain('collapsed');
      const roundTrip = markdownToDoc(md);
      const h1 = roundTrip.content?.[0];
      expect(h1?.attrs?.collapsible).toBe(true);
      expect(h1?.attrs?.collapsed).toBe(false);
    });
  });

  describe('Ticket #40: Up to 7 columns', () => {
    test('supports MAX_PAGE_COLUMNS = 7', () => {
      expect(MAX_PAGE_COLUMNS).toBe(7);
    });

    test('parses and normalizes column widths for up to 7 columns', () => {
      const widths = [10, 15, 15, 20, 10, 15, 15];
      const encoded = formatColumnWidths(widths, 7);
      expect(encoded).toBe('10,15,15,20,10,15,15');
      const parsed = parseColumnWidths(encoded, 7);
      expect(parsed).toEqual(widths);
    });

    test('round-trip 7 columns in markdown', () => {
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'columns',
            attrs: { widths: [10, 15, 15, 20, 10, 15, 15] },
            content: Array.from({ length: 7 }, (_, i) => ({
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Col ${i + 1}` }] }],
            })),
          },
        ],
      };
      const md = docToMarkdown(doc);
      expect(md).toContain('data-widths="10,15,15,20,10,15,15"');
      const roundTrip = markdownToDoc(md);
      const cols = roundTrip.content?.[0];
      expect(cols?.type).toBe('columns');
      expect(cols?.content?.length).toBe(7);
      expect(cols?.attrs?.widths).toEqual([10, 15, 15, 20, 10, 15, 15]);
    });
  });

});
