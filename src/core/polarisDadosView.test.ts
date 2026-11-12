import { describe, expect, it } from 'vitest';
import { MAX_DOC_DEPTH } from './model';
import type { DocNode } from './model';
import { docToPlainText, validateDoc } from './doc';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
  type PolarisDadosViewData,
} from './polarisDadosView';
import { docToHtml, type RenderContext } from './site';
import { findUnrepresentablePageContent } from './vault/compatibility';

const view = (data: PolarisDadosViewData): DocNode => ({ type: 'polarisDadosView', attrs: data });
const paragraph = (text: string): DocNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const DATA: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-α',
  sourceDatabaseId: 'db-42',
  title: 'Título --> linha 1\nlinha 2 🌒',
  columnOrder: ['name', 'price'],
  filter: { propertyId: 'price', op: 'gte', value: 0 },
};

function rawMarker(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `<!-- morrow:polaris-dados-view:v1:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')} -->`;
}

describe('Polaris Dados linked-view codec', () => {
  it('encodes stable canonical UTF-8 base64url and decodes every field', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    expect(marker).toMatch(/^<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->$/);
    expect(marker).toBe(encodePolarisDadosViewMarker({ ...DATA, columnOrder: [...DATA.columnOrder] }));
    expect(decodePolarisDadosViewMarker(marker)).toEqual(DATA);
  });

  it('rejects noncanonical base64url, invalid UTF-8 and ambiguous or unknown JSON', () => {
    expect(decodePolarisDadosViewMarker('<!-- morrow:polaris-dados-view:v1:YWJj= -->')).toBeNull();
    expect(decodePolarisDadosViewMarker('<!-- morrow:polaris-dados-view:v1:YR -->')).toBeNull();

    const invalidUtf8 = btoa(String.fromCharCode(0xff)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodePolarisDadosViewMarker(`<!-- morrow:polaris-dados-view:v1:${invalidUtf8} -->`)).toBeNull();
    expect(decodePolarisDadosViewMarker(rawMarker('{'))).toBeNull();
    expect(
      decodePolarisDadosViewMarker(rawMarker('{"version":1,"viewId":"a","viewId":"b"}')),
    ).toBeNull();
    expect(
      decodePolarisDadosViewMarker(
        rawMarker(
          '{"version":1,"viewId":"a","sourceDatabaseId":"db","title":"x","columnOrder":[],"filter":null,"extra":true}',
        ),
      ),
    ).toBeNull();
    const payload = encodePolarisDadosViewMarker(DATA).match(/:v1:([A-Za-z0-9_-]+) -->$/)![1]!;
    expect(decodePolarisDadosViewMarker(`<!-- morrow:polaris-dados-view:v2:${payload} -->`)).toBeNull();
  });

  it('round-trips the standalone block between adjacent text without interpreting its title as HTML', () => {
    const source: DocNode = {
      type: 'doc',
      content: [paragraph('Before'), view(DATA), paragraph('After')],
    };
    const markdown = docToMarkdown(source);
    const parsed = markdownToDoc(markdown);
    expect(parsed.content).toEqual(source.content);
    expect(markdown).toContain(encodePolarisDadosViewMarker(DATA));
    expect(validateDoc(parsed).ok).toBe(true);
  });

  it('keeps comment-like text inside a fenced code block literal', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const raw = `\`\`\`md\n${marker}\n\`\`\`\n`;
    expect(findUnrepresentablePageContent(raw)).toBeNull();
    const parsed = markdownToDoc(raw);
    expect(parsed.content?.map((node) => node.type)).toEqual(['codeBlock']);
    expect(parsed.content?.[0]?.content?.[0]?.text).toBe(marker);
    expect(findUnrepresentablePageContent(`\`${marker}\``)).toBeNull();
  });

  it.each([20, 21, 32, 64, 65])('protects a view marker beyond the parser nesting limit (%i)', (depth) => {
    const marker = encodePolarisDadosViewMarker(DATA);
    expect(findUnrepresentablePageContent(`${'> '.repeat(depth)}${marker}\n`)).not.toBeNull();
  });

  it('allows a view marker at the last depth representable by the native parser', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const markdown = `${'> '.repeat(19)}${marker}\n`;
    const parsed = markdownToDoc(markdown);
    const containsView = (node: DocNode): boolean =>
      node.type === 'polarisDadosView' || (node.content ?? []).some(containsView);

    expect(findUnrepresentablePageContent(markdown)).toBeNull();
    expect(containsView(parsed)).toBe(true);
    expect(validateDoc(parsed).ok).toBe(true);
  });

  it('keeps invalid, duplicate, inline and legacy comments protected before parsing', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const invalid = marker.replace('v1:', 'v2:');
    const cases = [
      invalid,
      marker.slice(0, -4),
      `Text ${marker} inline`,
      `${marker}\n\n${encodePolarisDadosViewMarker(DATA)}`,
      '<!-- morrow:linked-view:v1:opaque-id -->',
      `${'> '.repeat(MAX_DOC_DEPTH + 1)}${marker}`,
    ];
    for (const raw of cases) expect(findUnrepresentablePageContent(raw)).not.toBeNull();
    expect(markdownToDoc(invalid).content?.[0]?.type).toBe('rawBlock');
  });

  it.each([
    ['blockquote', (child: DocNode): DocNode => ({ type: 'blockquote', content: [paragraph('Before'), child] })],
    [
      'listItem',
      (child: DocNode): DocNode => ({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('Before'), child] }],
      }),
    ],
    [
      'taskItem',
      (child: DocNode): DocNode => ({
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph('Before'), child] }],
      }),
    ],
    ['callout', (child: DocNode): DocNode => ({ type: 'callout', attrs: { kind: 'note' }, content: [child] })],
    [
      'detailsContent',
      (child: DocNode): DocNode => ({
        type: 'details',
        content: [
          { type: 'detailsSummary', content: [{ type: 'text', text: 'Summary' }] },
          { type: 'detailsContent', content: [child] },
        ],
      }),
    ],
    ['column', (child: DocNode): DocNode => ({ type: 'columns', content: [{ type: 'column', content: [child] }] })],
  ])('preserves a linked-view atom inside %s', (_name, wrap) => {
    const source: DocNode = { type: 'doc', content: [wrap(view(DATA))] };
    const markdown = docToMarkdown(source);
    expect(findUnrepresentablePageContent(markdown), markdown).toBeNull();
    const parsed = markdownToDoc(markdown);
    expect(validateDoc(parsed).ok).toBe(true);
    const types: string[] = [];
    const visit = (node: DocNode) => {
      types.push(node.type);
      node.content?.forEach(visit);
    };
    visit(parsed);
    expect(types).toContain('polarisDadosView');
  });

  it.each([
    [
      'listItem',
      (child: DocNode): DocNode => ({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [child] }],
      }),
    ],
    [
      'taskItem',
      (child: DocNode): DocNode => ({
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [child] }],
      }),
    ],
  ])('rejects a linked-view atom as the first child of %s', (_name, wrap) => {
    const source: DocNode = { type: 'doc', content: [wrap(view(DATA))] };
    expect(validateDoc(source).ok).toBe(false);
    expect(() => docToMarkdown(source)).toThrow(/leading paragraph/i);
  });

  it('protects Markdown whose first list-item block is a linked-view marker', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    expect(findUnrepresentablePageContent(`-\n  ${marker}\n`)).not.toBeNull();
    expect(findUnrepresentablePageContent(`- # Heading\n\n  ${marker}\n`)).not.toBeNull();
    expect(findUnrepresentablePageContent(`- \`\`\`\n  code\n  \`\`\`\n\n  ${marker}\n`)).not.toBeNull();
    expect(findUnrepresentablePageContent(`- > ${marker}\n`)).not.toBeNull();
    expect(findUnrepresentablePageContent(`- <details><summary>Title</summary>${marker}</details>\n`)).not.toBeNull();
    expect(findUnrepresentablePageContent(`- [ ]\n  ${marker}\n`)).toBeNull();
  });

  it('keeps invalid first-list markers raw during Markdown paste parsing', () => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const containsView = (node: DocNode): boolean =>
      node.type === 'polarisDadosView' || (node.content ?? []).some(containsView);
    for (const source of [`-\n  ${marker}\n`, `- # Heading\n\n  ${marker}\n`]) {
      const parsed = markdownToDoc(source);
      expect(containsView(parsed)).toBe(false);
      expect(validateDoc(parsed).ok).toBe(true);
      const raw = JSON.stringify(parsed);
      expect(raw).toContain(marker);
    }
  });

  it.each([32, 64, 65])('protects a linked-view marker beyond the DocNode depth limit (%i)', (depth) => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const open = '<details>\n<summary>Nested</summary>\n\n';
    const close = '\n\n</details>';
    const deeplyNested = open.repeat(depth) + marker + close.repeat(depth);

    expect(findUnrepresentablePageContent(deeplyNested)).not.toBeNull();
  });

  it.each([21, 31])('round-trips a marker inside representable nested details (%i)', (depth) => {
    const marker = encodePolarisDadosViewMarker(DATA);
    const open = '<details>\n<summary>Nested</summary>\n\n';
    const close = '\n\n</details>';
    const source = open.repeat(depth) + marker + close.repeat(depth);
    const parsed = markdownToDoc(source);
    const containsView = (node: DocNode): boolean =>
      node.type === 'polarisDadosView' || (node.content ?? []).some(containsView);

    expect(findUnrepresentablePageContent(source)).toBeNull();
    expect(validateDoc(parsed).ok).toBe(true);
    expect(containsView(parsed)).toBe(true);
    expect(findUnrepresentablePageContent(docToMarkdown(parsed))).toBeNull();
  });

  it('round-trips a list-item view after an explicit empty paragraph', () => {
    const source: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [] }, view(DATA)] }],
        },
      ],
    };
    expect(validateDoc(source).ok).toBe(true);
    const markdown = docToMarkdown(source);
    expect(findUnrepresentablePageContent(markdown), markdown).toBeNull();
    const parsed = markdownToDoc(markdown);
    const containsView = (node: DocNode): boolean =>
      node.type === 'polarisDadosView' || (node.content ?? []).some(containsView);
    expect(containsView(parsed)).toBe(true);
    expect(validateDoc(parsed).ok).toBe(true);
  });

  it('round-trips a task-item view after its explicit empty checkbox paragraph', () => {
    const source: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [] }, view(DATA)],
            },
          ],
        },
      ],
    };
    expect(validateDoc(source).ok).toBe(true);
    const markdown = docToMarkdown(source);
    expect(findUnrepresentablePageContent(markdown)).toBeNull();
    const parsed = markdownToDoc(markdown);
    const containsView = (node: DocNode): boolean =>
      node.type === 'polarisDadosView' || (node.content ?? []).some(containsView);
    expect(containsView(parsed)).toBe(true);
    expect(validateDoc(parsed).ok).toBe(true);
  });

  it('validates exact atom shape, representable placement and unique IDs per document', () => {
    const valid = { type: 'doc', content: [view(DATA)] };
    expect(validateDoc(valid).ok).toBe(true);
    expect(validateDoc({ type: 'doc', content: [view(DATA), view(DATA)] }).ok).toBe(false);
    expect(validateDoc({ type: 'doc', content: [paragraph('inline'), view(DATA)] }).ok).toBe(true);
    expect(
      validateDoc({
        type: 'doc',
        content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [view(DATA)] }] }],
      }).ok,
    ).toBe(false);
    expect(
      validateDoc({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [{ type: 'blockquote', content: [view(DATA)] }] }],
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateDoc({
        type: 'doc',
        content: [{ type: 'paragraph', content: [view(DATA)] }],
      }).ok,
    ).toBe(false);
    expect(validateDoc({ type: 'doc', content: [{ ...view(DATA), children: [] }] }).ok).toBe(false);
    expect(validateDoc({ type: 'doc', content: [{ ...view(DATA), attrs: { ...DATA, extra: true } }] }).ok).toBe(false);
  });

  it('shows a text and HTML-safe inert fallback in plaintext and site exports', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [view({ ...DATA, title: '<script>alert(1)</script>', sourceDatabaseId: 'db<&' })],
    };
    expect(docToPlainText(doc)).toContain('Linked view unavailable');
    expect(docToPlainText(doc)).toContain('Source database: db<&');
    const context: RenderContext = {
      href: () => null,
      assetPath: () => '',
      titleOf: () => null,
      renderMath: undefined,
    };
    const html = docToHtml(doc, context);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('db&lt;&amp;');
    expect(html).toContain('Linked view unavailable.');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('fails explicitly instead of silently serializing an invalid atom or inline placement', () => {
    expect(() => docToMarkdown({ type: 'doc', content: [{ ...view(DATA), attrs: { ...DATA, extra: true } }] })).toThrow(
      /unsupported/i,
    );
    expect(() => docToMarkdown({ type: 'doc', content: [{ type: 'paragraph', content: [view(DATA)] }] })).toThrow(
      /position|inline/i,
    );
  });
});
