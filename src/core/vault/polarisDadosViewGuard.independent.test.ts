import { describe, expect, it } from 'vitest';
import { docToPlainText, validateDoc } from '../doc';
import type { DocNode } from '../model';
import { MAX_DOC_DEPTH } from '../model';
import { markdownToDoc } from '../markdown/parse';
import { docToMarkdown } from '../markdown/serialize';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
} from '../polarisDadosView';
import type { PolarisDadosViewData } from '../polarisDadosView';
import { findUnrepresentablePageContent } from './compatibility';

const MARKER_PREFIX = '<!-- morrow:polaris-dados-view:v1:';
const MARKER_SUFFIX = ' -->';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const sample = (overrides: Partial<PolarisDadosViewData> = {}): PolarisDadosViewData => ({
  version: 1,
  viewId: 'view-one',
  sourceDatabaseId: 'missing-source',
  title: 'Synthetic view',
  columnOrder: ['name', 'quantity'],
  filter: null,
  ...overrides,
});

function markerFromBytes(bytes: Uint8Array): string {
  return MARKER_PREFIX + Buffer.from(bytes).toString('base64url') + MARKER_SUFFIX;
}

function rawMarker(value: unknown): string {
  return markerFromBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function markerFromJson(json: string): string {
  return markerFromBytes(Buffer.from(json, 'utf8'));
}

function nonCanonicalBase64Url(marker: string): string {
  const encoded = marker.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
  const bytes = Buffer.from(encoded, 'base64url');
  const remainder = bytes.length % 3;
  if (remainder === 0) throw new Error('Fixture needs unused base64url trailing bits.');
  const mask = remainder === 1 ? 0b1111 : 0b0011;
  const index = BASE64URL.indexOf(encoded.at(-1)!);
  const changed = (index & ~mask) | 1;
  return MARKER_PREFIX + encoded.slice(0, -1) + BASE64URL[changed] + MARKER_SUFFIX;
}

function oversizedMarker(): string {
  const value = sample({
    columnOrder: Array.from(
      { length: 1000 },
      (_, index) => String(index).padStart(4, '0') + '-' + 'x'.repeat(80),
    ),
  });
  return rawMarker(value);
}

function containsLinkedView(doc: DocNode): boolean {
  if (doc.type === 'polarisDadosView') return true;
  return (doc.content ?? []).some((node) => containsLinkedView(node));
}

describe('independent linked-view Markdown representability guard', () => {
  it('allows only a valid standalone v1 marker while keeping absent source resolution out of the codec', () => {
    const marker = encodePolarisDadosViewMarker(sample());
    const source = 'Before.\n\n' + marker + '\n\nAfter.\n';

    expect(decodePolarisDadosViewMarker(marker)).toEqual(sample());
    expect(findUnrepresentablePageContent(marker)).toBeNull();
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const parsed = markdownToDoc(source);
    expect(parsed.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'polarisDadosView',
      'paragraph',
    ]);
    expect(validateDoc(parsed).ok).toBe(true);
    expect(docToMarkdown(parsed)).toContain(marker);

    const blockquote = docToMarkdown({
      type: 'doc',
      content: [{ type: 'blockquote', content: [{ type: 'polarisDadosView', attrs: sample() }] }],
    });
    expect(findUnrepresentablePageContent(blockquote)).toBeNull();
    expect(markdownToDoc(blockquote)).toEqual({
      type: 'doc',
      content: [{ type: 'blockquote', content: [{ type: 'polarisDadosView', attrs: sample() }] }],
    });

    const details =
      '<details>\n<summary>Nested view</summary>\n\n' +
      marker +
      '\n\n</details>\n';
    expect(findUnrepresentablePageContent(details)).toBeNull();
    const parsedDetails = markdownToDoc(details);
    expect(validateDoc(parsedDetails).ok).toBe(true);
    expect(containsLinkedView(parsedDetails)).toBe(true);

    const columns = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            { type: 'column', content: [{ type: 'polarisDadosView', attrs: sample() }] },
          ],
        },
      ],
    });
    expect(findUnrepresentablePageContent(columns)).toBeNull();
    expect(markdownToDoc(columns)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            { type: 'column', content: [{ type: 'polarisDadosView', attrs: sample() }] },
          ],
        },
      ],
    });
  });

  it.each([
    ['listItem first atom', '-\n  '],
    ['listItem with a heading first', '- # Heading\n\n  '],
    ['listItem with a blockquote first', '- > Quote\n  >\n  > '],
  ])('protects a non-paragraph list start (%s) instead of normalizing a new paragraph', (_name, prefix) => {
    const markdown = prefix + encodePolarisDadosViewMarker(sample()) + '\n';
    expect(findUnrepresentablePageContent(markdown)).not.toBeNull();
  });

  it('allows a linked view after the explicit empty paragraph in a task-only item', () => {
    const markdown = '- [ ]\n  ' + encodePolarisDadosViewMarker(sample()) + '\n';
    expect(findUnrepresentablePageContent(markdown)).toBeNull();
    const parsed = markdownToDoc(markdown);
    expect(validateDoc(parsed).ok).toBe(true);
    expect(containsLinkedView(parsed)).toBe(true);
  });

  it.each([
    [
      'listItem',
      (view: DocNode): DocNode => ({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }, view] }],
      }),
    ],
    [
      'taskItem',
      (view: DocNode): DocNode => ({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [] }, view] },
        ],
      }),
    ],
  ])('round-trips a linked view after its required paragraph in %s', (_name, wrap) => {
    const source: DocNode = {
      type: 'doc',
      content: [wrap({ type: 'polarisDadosView', attrs: sample() })],
    };
    expect(validateDoc(source).ok).toBe(true);

    const markdown = docToMarkdown(source);
    expect(findUnrepresentablePageContent(markdown)).toBeNull();
    const parsed = markdownToDoc(markdown);
    expect(validateDoc(parsed).ok).toBe(true);
    expect(containsLinkedView(parsed)).toBe(true);
    expect(findUnrepresentablePageContent(docToMarkdown(parsed))).toBeNull();
  });

  it('protects unknown, extra-field, malformed, non-canonical, oversized, and duplicate markers', () => {
    const valid = encodePolarisDadosViewMarker(sample());
    const encoded = valid.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
    const invalidUtf8 = markerFromBytes(
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    );
    const cases = [
      '<!-- morrow:polaris-dados-view:v2:' + encoded + MARKER_SUFFIX,
      rawMarker({ ...sample(), version: 2 }),
      rawMarker({ ...sample(), futureOption: 'preserve me' }),
      '<!-- morrow:polaris-dados-view:v1:%%% -->',
      MARKER_PREFIX + encoded + '= -->',
      nonCanonicalBase64Url(valid),
      markerFromJson(
        '{"version":1, "viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '{"version":1,"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '\uFEFF{"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '{"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":{"propertyId":"quantity","op":"gte","value":1.0}}',
      ),
      invalidUtf8,
      oversizedMarker(),
      encodePolarisDadosViewMarker(sample()) +
        '\n\n' +
        encodePolarisDadosViewMarker(sample({ title: 'second node, duplicated identity' })),
    ];

    for (const source of cases) {
      expect(findUnrepresentablePageContent(source)).not.toBeNull();
    }
  });

  it('keeps the legacy fork marker opaque and rejects inline marker occurrences', () => {
    const legacy = '<!-- morrow:linked-view:v1:opaque-id -->';
    const inline = 'Text before ' + encodePolarisDadosViewMarker(sample()) + ' text after';
    const legacyInline = 'Text before ' + legacy + ' text after';

    expect(findUnrepresentablePageContent(legacy)).not.toBeNull();
    const legacyDoc = markdownToDoc(legacy);
    expect(legacyDoc.content?.[0]?.type).toBe('rawBlock');
    expect(docToMarkdown(legacyDoc)).toContain(legacy);

    expect(findUnrepresentablePageContent(inline)).not.toBeNull();
    expect(containsLinkedView(markdownToDoc(inline))).toBe(false);
    expect(findUnrepresentablePageContent(legacyInline)).not.toBeNull();
    expect(containsLinkedView(markdownToDoc(legacyInline))).toBe(false);
  });

  it.each([21, 31])('round-trips a linked-view marker at supported details depth %i', (depth) => {
    const marker = encodePolarisDadosViewMarker(sample());
    const open = '<details>\n<summary>Nested</summary>\n\n';
    const close = '\n\n</details>';
    const nested = open.repeat(depth) + marker + close.repeat(depth);

    expect(findUnrepresentablePageContent(nested)).toBeNull();
    const parsed = markdownToDoc(nested);
    expect(validateDoc(parsed).ok).toBe(true);
    expect(containsLinkedView(parsed)).toBe(true);
    const roundTrip = docToMarkdown(parsed);
    expect(findUnrepresentablePageContent(roundTrip)).toBeNull();
    expect(markdownToDoc(roundTrip)).toEqual(parsed);
  });

  it.each([32, MAX_DOC_DEPTH, MAX_DOC_DEPTH + 1])(
    'protects a linked-view marker inside %i nested details wrappers before Markdown normalization',
    (depth) => {
    const marker = encodePolarisDadosViewMarker(sample());
    const open = '<details>\n<summary>Nested</summary>\n\n';
    const close = '\n\n</details>';
    const deeplyNested = open.repeat(depth) + marker + close.repeat(depth);
    expect(findUnrepresentablePageContent(deeplyNested)).not.toBeNull();
    },
  );

  it('allows a linked-view marker at the deepest native blockquote depth', () => {
    const marker = encodePolarisDadosViewMarker(sample());
    const markdown = '> '.repeat(19) + marker + '\n';
    expect(findUnrepresentablePageContent(markdown)).toBeNull();
    const parsed = markdownToDoc(markdown);
    expect(validateDoc(parsed).ok).toBe(true);
    expect(containsLinkedView(parsed)).toBe(true);
  });

  it.each([20, 21, 32, 64, MAX_DOC_DEPTH + 1])(
    'protects a linked-view marker inside %i nested blockquotes before Markdown normalization',
    (depth) => {
      const marker = encodePolarisDadosViewMarker(sample());
      const deeplyQuoted = '> '.repeat(depth) + marker + '\n';
      expect(findUnrepresentablePageContent(deeplyQuoted)).not.toBeNull();
    },
  );

  it('treats a fenced or inline-code marker as literal Markdown, not a linked view or a protected Morrow block', () => {
    const marker = encodePolarisDadosViewMarker(sample());
    const fence = String.fromCharCode(96).repeat(3);
    const fenced = fence + 'markdown\n' + marker + '\n' + fence + '\n';
    const tick = String.fromCharCode(96);
    const inlineCode = 'Literal ' + tick + marker + tick + ' text.\n';

    expect(findUnrepresentablePageContent(fenced)).toBeNull();
    const fencedDoc = markdownToDoc(fenced);
    expect(containsLinkedView(fencedDoc)).toBe(false);
    expect(fencedDoc.content?.[0]?.type).toBe('codeBlock');
    expect(docToPlainText(fencedDoc)).toContain(marker);

    expect(findUnrepresentablePageContent(inlineCode)).toBeNull();
    expect(containsLinkedView(markdownToDoc(inlineCode))).toBe(false);
  });
});
