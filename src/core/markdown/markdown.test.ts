import { describe, expect, it } from 'vitest';
import { anchorSlice } from '../anchors';
import { resizeColumnWidths } from '../model';
import type { DocNode } from '../model';
import { markdownToDoc, markdownToPage } from './parse';
import { docToMarkdown } from './serialize';

const text = (value: string, marks?: string[]): DocNode =>
  marks
    ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text: value };
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });

// a realistic note touching every supported block
const NOTE = `## Weekly review

Shipped the **sidebar** rewrite, fixed *two* bugs and wrote \`docs\`. See [the plan](https://example.org/plan).

Also <u>underlined</u> and ~~struck~~ text.

- Groceries
  - oat milk
  - bread
- Post office

1. Draft
2. Edit
3. Publish

- [x] Book train tickets
- [ ] Call the landlord

> Simplicity is prerequisite for reliability.

\`\`\`ts
const answer = 42;
\`\`\`

---

| Book | Author |
| --- | --- |
| Middlemarch | George Eliot |
| Piranesi | Susanna Clarke |
`;

describe('markdown import', () => {
  const doc = markdownToDoc(NOTE);
  const types = doc.content!.map((node) => node.type);

  it('maps every supported block', () => {
    expect(types).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'horizontalRule',
      'table',
    ]);
  });

  it('keeps inline formatting', () => {
    const marks = doc.content![1]!.content!.flatMap((node) => (node.marks ?? []).map((mark) => mark.type));
    expect(marks).toEqual(expect.arrayContaining(['bold', 'italic', 'code', 'link']));
    const second = doc.content![2]!.content!.flatMap((node) => (node.marks ?? []).map((mark) => mark.type));
    expect(second).toEqual(['underline', 'strike']);
  });

  it('reads checklists, nesting and code languages', () => {
    const tasks = doc.content![5]!.content!;
    expect(tasks.map((item) => item.attrs?.checked)).toEqual([true, false]);
    expect(tasks[0]!.content![0]!.content![0]!.text).toBe('Book train tickets');
    expect(doc.content![3]!.content![0]!.content![1]!.type).toBe('bulletList');
    expect(doc.content![7]!.attrs?.language).toBe('ts');
  });

  it('builds tables with a header row', () => {
    const rows = doc.content![9]!.content!;
    expect(rows).toHaveLength(3);
    expect(rows[0]!.content![0]!.type).toBe('tableHeader');
    expect(rows[1]!.content![1]!.content![0]!.content![0]!.text).toBe('George Eliot');
  });

  it('uses the first level one heading as the title', () => {
    const page = markdownToPage('# Trip notes\n\nPack light.', 'file');
    expect(page.title).toBe('Trip notes');
    expect(page.doc.content).toHaveLength(1);
    expect(markdownToPage('Just text', 'fallback').title).toBe('fallback');
  });

  it('reads full-block backgrounds from harmless Markdown comments', () => {
    const source =
      '<!-- morrow:block-background:blue -->\n## Character\n\n<!-- morrow:block-background:yellow -->\nA paragraph in the character column.';
    const doc = markdownToDoc(source);
    expect(doc.content?.map((node) => node.attrs?.blockBackground)).toEqual(['blue', 'yellow']);
    const reopened = markdownToDoc(docToMarkdown(doc));
    expect(reopened.content?.map((node) => node.attrs?.blockBackground)).toEqual(['blue', 'yellow']);
    expect(reopened.content?.map((node) => node.type)).toEqual(['heading', 'paragraph']);
  });

  it('resolves wiki links and keeps links to pages that do not exist yet', () => {
    const doc = markdownToDoc('See [[Garden]] and [[Nowhere]].', {
      resolvePage: (title) => (title === 'Garden' ? 'g1' : null),
    });
    const nodes = doc.content![0]!.content!;
    expect(nodes.map((node) => node.type)).toEqual(['text', 'pageLink', 'text', 'pageLink', 'text']);
    expect(nodes[1]!.attrs).toEqual({ id: 'g1', label: 'Garden' });
    expect(nodes[3]!.attrs).toEqual({ id: null, label: 'Nowhere', target: 'Nowhere' });
    const plain = markdownToDoc('See [[Nowhere]].', { keepUnresolved: false });
    expect(plain.content![0]!.content).toEqual([text('See [[Nowhere]].')]);
  });

  it('preserves resolved Markdown page-link text, href encoding, and anchor', () => {
    const source = '[abrir o coração](./Refer%C3%AAncia%20%C3%81rvore.md#cora%C3%A7%C3%A3o-da-%C3%A1rvore)';
    const doc = markdownToDoc(source, { resolveLink: () => 'reference' });
    const link = doc.content![0]!.content![0]!;

    expect(link).toMatchObject({
      type: 'pageLink',
      attrs: {
        id: 'reference',
        label: 'abrir o coração',
        markdownHref: './Refer%C3%AAncia%20%C3%81rvore.md#cora%C3%A7%C3%A3o-da-%C3%A1rvore',
        anchor: 'coração-da-árvore',
      },
    });
    expect(docToMarkdown(doc)).toBe(`${source}\n`);
    // A title change without a file move keeps this relative Markdown target valid.
    expect(docToMarkdown(doc, { titleOf: () => 'Referência Atualizada' })).toBe(`${source}\n`);
  });

  it('splits mixed task and bullet lists', () => {
    const doc = markdownToDoc('- [ ] task\n- plain\n- [x] done\n- [ ]');
    expect(doc.content!.map((node) => node.type)).toEqual(['taskList', 'bulletList', 'taskList']);
    expect(doc.content![2]!.content).toHaveLength(2);
  });

  it('imports Notion empty and non-breaking-space checkboxes as tasks', () => {
    const doc = markdownToDoc('- [] Open\n- [\u00a0] Waiting\n- [x] Done');
    expect(doc.content!.map((node) => node.type)).toEqual(['taskList']);
    expect(doc.content![0]!.content!.map((item) => item.attrs?.checked)).toEqual([false, false, true]);
  });

  it('handles empty and hostile input', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(() => markdownToDoc('>'.repeat(5000))).not.toThrow();
    expect(() => markdownToDoc('['.repeat(10000))).not.toThrow();
  });
});

describe('linked database view markdown persistence', () => {
  it('round trips the source and view configuration while leaving a readable fallback', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'linkedDatabaseView',
          attrs: {
            hostPageId: 'host',
            sourceDatabaseId: 'records',
            blockId: 'linked-block',
            view: {
              id: 'linked-view',
              name: 'Open tasks',
              type: 'board',
              filters: [],
              filterGroups: [
                {
                  id: 'group',
                  logic: 'or',
                  filters: [{ id: 'rule', prop: 'status', op: 'is', value: 'open' }],
                },
              ],
              filterGroupLogic: 'and',
              sorts: [{ prop: 'title', dir: 'asc' }],
              groupBy: 'status',
              dateProp: null,
              hidden: [],
              search: 'alpha',
              order: ['status'],
              wrap: ['status'],
              align: { status: 'center' },
              summaries: { points: 'sum' },
              conditionalFormats: [
                { id: 'color', prop: 'status', op: 'is', value: 'open', scope: 'row', color: 'green' },
              ],
              cardProperties: ['points'],
              cardImageProp: null,
            },
          },
        },
      ],
    };
    const markdown = docToMarkdown(doc, { titleOf: (id) => (id === 'records' ? 'Records' : null) });
    expect(markdown).toContain('[[Records]] — open in Morrow to edit shared rows.');
    expect(markdown).toContain('morrow:linked-view:v1:');
    const restored = markdownToDoc(markdown);
    expect(restored.content).toHaveLength(1);
    expect(restored.content![0]!.type).toBe('linkedDatabaseView');
    expect(restored.content![0]!.attrs).toMatchObject({
      sourceDatabaseId: 'records',
      blockId: 'linked-block',
      view: {
        id: 'linked-view',
        search: 'alpha',
        filterGroupLogic: 'and',
        filterGroups: [{ logic: 'or' }],
        summaries: { points: 'sum' },
        cardImageProp: null,
      },
    });
  });
});

describe('markdown export', () => {
  it('round trips a realistic note without losing structure or text', () => {
    const first = markdownToDoc(NOTE);
    const exported = docToMarkdown(first);
    expect(markdownToDoc(exported)).toEqual(first);
  });

  it('writes the expected syntax', () => {
    const out = docToMarkdown(markdownToDoc(NOTE));
    expect(out).toContain('## Weekly review');
    expect(out).toContain('**sidebar**');
    expect(out).toContain('- [x] Book train tickets');
    expect(out).toContain('  - oat milk');
    expect(out).toContain('```ts\nconst answer = 42;\n```');
    expect(out).toContain('| Middlemarch | George Eliot |');
  });

  it('escapes characters that would otherwise become formatting', () => {
    const doc: DocNode = { type: 'doc', content: [p(text('# not a heading *nor* _this_ [x]'))] };
    const out = docToMarkdown(doc);
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('keeps whitespace outside of marks', () => {
    const doc: DocNode = { type: 'doc', content: [p(text('a'), text(' bold ', ['bold']), text('b'))] };
    expect(docToMarkdown(doc)).toBe('a **bold** b\n');
  });

  it('writes page links as wiki links with current titles', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [p(text('see '), { type: 'pageLink', attrs: { id: 'x', label: 'Old' } })],
    };
    expect(docToMarkdown(doc, { titleOf: () => 'New title' })).toBe('see [[New title]]\n');
  });

  it('fences code that contains backticks', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', attrs: { language: null }, content: [text('```\nx')] }],
    };
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });
});

describe('obsidian flavoured markdown', () => {
  const roundTrip = (source: string) => docToMarkdown(markdownToDoc(source, { resolvePage: () => null }));

  it('reads aliases, headings and embeds in wiki links', () => {
    const doc = markdownToDoc('[[Projects/Garden#Beds|the beds]] ![[Diagram]]', {
      resolvePage: (target) => (target === 'Projects/Garden' ? 'g' : null),
    });
    const [link, , embed] = doc.content![0]!.content!;
    expect(link!.attrs).toEqual({ id: 'g', label: 'the beds', anchor: 'Beds', alias: 'the beds' });
    expect(embed!.attrs).toMatchObject({ id: null, target: 'Diagram', embed: true });
  });

  it('round trips wiki links, callouts, maths and highlights exactly', () => {
    const source = [
      'See [[Garden#Beds|the beds]] and ![[Sketch]].',
      '',
      '> [!warning]- Watch out',
      '> The ==soil== is wet.',
      '',
      'Energy is $E = mc^2$ but it costs $5 and $10.',
      '',
      '$$',
      '\\int_0^1 x\\,dx',
      '$$',
      '',
      '<div class="custom">kept as written</div>',
      '',
    ].join('\n');
    expect(roundTrip(source)).toBe(source);
  });

  it('reads callout types, titles and folding', () => {
    const doc = markdownToDoc('> [!TIP]+ Remember\n> Water daily.');
    expect(doc.content![0]).toEqual({
      type: 'callout',
      attrs: { tone: 'tip', kind: 'tip', title: 'Remember', fold: '+' },
      content: [p(text('Water daily.'))],
    });
  });

  it('keeps maths and highlights out of code', () => {
    const doc = markdownToDoc('`$x$` and `==y==`');
    expect(doc.content![0]!.content!.every((node) => node.type === 'text')).toBe(true);
  });

  it('does not escape ordinary punctuation', () => {
    const doc: DocNode = { type: 'doc', content: [p(text('snake_case [x] #tag 100% a+b'))] };
    expect(docToMarkdown(doc)).toBe('snake_case [x] #tag 100% a+b\n');
  });

  it('keeps remote images as images without loading them', () => {
    const doc = markdownToDoc('![logo](https://example.org/logo.png)');
    expect(doc.content![0]).toEqual({
      type: 'image',
      attrs: { fileId: null, src: 'https://example.org/logo.png', alt: 'logo' },
    });
    expect(docToMarkdown(doc)).toBe('![logo](https://example.org/logo.png)\n');
  });

  it('escapes text that would otherwise become a link, maths or a highlight', () => {
    const doc: DocNode = { type: 'doc', content: [p(text('[[not a link]] $a$ and $b$ ==no== [x](y)'))] };
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });
});

describe('colours', () => {
  it('round trips text colours and coloured highlights as html other apps show', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        p(
          { type: 'text', text: 'red words', marks: [{ type: 'textColor', attrs: { color: 'red' } }] },
          text(' and '),
          { type: 'text', text: 'blue marker', marks: [{ type: 'highlight', attrs: { color: 'blue' } }] },
          text(' and '),
          { type: 'text', text: 'plain marker', marks: [{ type: 'highlight' }] },
        ),
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe(
      '<span style="color: #d44c47">red words</span> and <mark style="background: #e7f3f8">blue marker</mark> and ==plain marker==\n',
    );
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('round trips custom text, highlight and block colours as six-digit hex', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockBackground: '#a1b2c3' },
          content: [
            { type: 'text', text: 'Signal', marks: [{ type: 'textColor', attrs: { color: '#124abc' } }] },
            text(' and '),
            { type: 'text', text: 'attention', marks: [{ type: 'highlight', attrs: { color: '#f0a5d2' } }] },
          ],
        },
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe(
      '<!-- morrow:block-background:#a1b2c3 -->\n' +
        '<span style="color: #124abc">Signal</span> and <mark style="background: #f0a5d2">attention</mark>\n',
    );
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('keeps custom six-digit colours and reads legacy shorthand into the nearest preset', () => {
    const custom = markdownToDoc('<span style="color: #ff0000">alarm</span>');
    expect(custom.content![0]!.content![0]!.marks).toEqual([
      { type: 'textColor', attrs: { color: '#ff0000' } },
    ]);
    const presetHex = markdownToDoc('<span style="color: #d44c47">alarm</span>');
    expect(presetHex.content![0]!.content![0]!.marks).toEqual([
      { type: 'textColor', attrs: { color: 'red' } },
    ]);
    const shorthand = markdownToDoc('<span style="color: #f00">alarm</span>');
    expect(shorthand.content![0]!.content![0]!.marks).toEqual([
      { type: 'textColor', attrs: { color: 'red' } },
    ]);
  });

  it('does not serialize unsupported or malicious colour values as CSS or HTML', () => {
    const payload = 'red; background-image: url(javascript:alert(1))';
    const unsafe: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockBackground: payload },
          content: [
            {
              type: 'text',
              text: 'unsafe',
              marks: [
                { type: 'textColor', attrs: { color: payload } },
                { type: 'highlight', attrs: { color: payload } },
              ],
            },
          ],
        },
      ],
    };
    const out = docToMarkdown(unsafe);
    expect(out).toBe('==unsafe==\n');
    expect(out).not.toContain(payload);

    const malformedHtml = markdownToDoc(
      '<span style="color: #123456; background-image: url(javascript:alert(1))">unsafe</span>',
    );
    const escaped = docToMarkdown(malformedHtml);
    expect(escaped).toContain('\\<span style=');
    expect(escaped).not.toMatch(/(?<!\\)<span style=/);
  });
});

describe('layout blocks', () => {
  it('keeps columns, a table of contents and dates through a save and load', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'tableOfContents' },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] },
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                {
                  type: 'paragraph',
                  attrs: { blockBackground: 'blue' },
                  content: [{ type: 'text', text: 'Left' }],
                },
              ],
            },
            {
              type: 'column',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Right' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Due ' },
            { type: 'dateMention', attrs: { date: '2026-10-20' } },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<!-- toc -->');
    expect(markdown).toContain('[[2026-10-20]]');
    expect(markdownToDoc(markdown)).toEqual(doc);
  });

  it('round trips per-block prose column proportions and clamps separator resizing', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          attrs: { widths: [20, 50, 30] },
          content: [
            { type: 'column', content: [p(text('Left'))] },
            { type: 'column', content: [p(text('Middle'))] },
            { type: 'column', content: [p(text('Right'))] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<div data-columns data-widths="20,50,30">');
    expect(markdownToDoc(markdown)).toEqual(doc);
    expect(resizeColumnWidths([50, 30, 20], 3, 0, 45, 12)).toEqual([68, 12, 20]);
    expect(resizeColumnWidths([50, 30, 20], 3, 1, 45, 12)).toEqual([50, 38, 12]);
  });

  it('ignores malformed or default prose column proportions', () => {
    const equal: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            { type: 'column', content: [p(text('Left'))] },
            { type: 'column', content: [p(text('Right'))] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(equal);
    expect(markdown).not.toContain('data-widths');
    expect(markdownToDoc(markdown)).toEqual(equal);

    const malformed = markdown.replace('<div data-columns>', '<div data-columns data-widths="0,100">');
    expect(markdownToDoc(malformed)).toEqual(equal);
    const mismatched = markdown.replace('<div data-columns>', '<div data-columns data-widths="25,50,25">');
    expect(markdownToDoc(mismatched)).toEqual(equal);
  });
});

describe('block ids and anchors', () => {
  it('keeps an obsidian block id on its paragraph and writes it back the same', () => {
    const source = 'A thought worth linking to ^idea-1\n\n- [ ] A task ^task9\n\n^loose\n';
    const doc = markdownToDoc(source);
    expect(doc.content![0]).toEqual({
      type: 'paragraph',
      attrs: { blockId: 'idea-1' },
      content: [{ type: 'text', text: 'A thought worth linking to' }],
    });
    expect(docToMarkdown(doc)).toBe(source);
  });

  it('cuts out the block or the heading section an anchor points at', () => {
    const doc = markdownToDoc(
      '# Plan\n\nIntro\n\n## Goals\n\nShip it ^ship\n\n### Detail\n\nMore\n\n## Later\n\nAfter\n',
    );
    expect(anchorSlice(doc, '^ship')?.content?.[0]?.attrs?.blockId).toBe('ship');
    const goals = anchorSlice(doc, 'goals');
    expect(goals?.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    expect(anchorSlice(doc, '^missing')).toBeNull();
  });
});

describe('things that used to change on a reload', () => {
  const files = {
    resolveFile: (href: string) => ({ fileId: href, name: href, image: href.endsWith('.png') }),
  };
  const settles = (markdown: string) => {
    let current = markdown;
    for (let i = 0; i < 3; i++)
      current = docToMarkdown(markdownToDoc(current, files), { filePath: (id) => id });
    return current;
  };

  it('keeps empty lines left between paragraphs', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph' },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
        { type: 'paragraph' },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toBe('One\n\n<br>\n\n<br>\n\nTwo\n');
    expect(markdownToDoc(markdown).content?.map((node) => (node.content ?? []).length)).toEqual([1, 0, 0, 1]);
  });

  it('keeps a picture in a nested bullet as a bullet, not a heading', () => {
    expect(settles('- parent\n  - ![](attachments/pic.png)\n')).toBe(
      '- parent\n  - ![](attachments/pic.png)\n',
    );
    expect(settles('- parent\n  - <br>\n  - b\n')).toBe('- parent\n  - <br>\n  - b\n');
  });
  it('round trips up to seven columns with explicit widths', () => {
    const cols = Array.from({ length: 7 }, (_, i) => ({
      type: 'column',
      content: [p(text(`Col ${i + 1}`))],
    }));
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          attrs: { widths: [10, 15, 15, 10, 20, 15, 15] },
          content: cols,
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<div data-columns data-widths="10,15,15,10,20,15,15">');
    const reopened = markdownToDoc(markdown);
    expect(reopened.content?.[0]?.type).toBe('columns');
    expect(reopened.content?.[0]?.attrs?.widths).toEqual([10, 15, 15, 10, 20, 15, 15]);
    expect(reopened.content?.[0]?.content?.length).toBe(7);
  });

  it('round trips image metadata including caption, alignment and crop', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: 'https://example.com/photo.jpg',
            alt: 'Landscape',
            align: 'center',
            caption: 'A scenic vista',
            crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
          },
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<!-- morrow:image align="center" caption="A scenic vista" crop="0.1,0.2,0.6,0.7" -->');
    expect(markdown).toContain('![Landscape](https://example.com/photo.jpg)');
    const reopened = markdownToDoc(markdown);
    const img = reopened.content?.[0];
    expect(img?.type).toBe('image');
    expect(img?.attrs?.align).toBe('center');
    expect(img?.attrs?.caption).toBe('A scenic vista');
    expect(img?.attrs?.crop).toEqual({ x: 0.1, y: 0.2, width: 0.6, height: 0.7 });
  });

  it('round trips collapsible and collapsed heading states', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, collapsible: true, collapsed: true },
          content: [text('Collapsible Section')],
        },
        p(text('Section content')),
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<!-- morrow:heading collapsible collapsed -->');
    expect(markdown).toContain('## Collapsible Section');
    const reopened = markdownToDoc(markdown);
    expect(reopened.content?.[0]?.type).toBe('heading');
    expect(reopened.content?.[0]?.attrs?.collapsible).toBe(true);
    expect(reopened.content?.[0]?.attrs?.collapsed).toBe(true);
    expect(reopened.content?.[1]?.type).toBe('paragraph');
  });
});
