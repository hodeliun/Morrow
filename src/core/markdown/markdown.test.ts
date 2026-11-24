import { describe, expect, it } from 'vitest';
import { anchorSlice } from '../anchors';
import type { DocNode, PageId, WorkspaceState } from '../model';
import { loadVault, makeResolver, resolveMarkdownPageLink } from '../vault/load';
import type { Resolver, VaultScan } from '../vault/load';
import type { Placement } from '../vault/layout';
import { scanMarkdownDestination } from './markdownLinkDestination';
import {
  inspectBlockBackgroundMarkers,
  markdownHrefPath,
  markdownToDoc,
  markdownToDocWithDetailsHtmlBlocks,
  markdownToPage,
} from './parse';
import { docToMarkdown } from './serialize';
import { formatBlockBackgroundMarker, parseBlockBackgroundMarker } from './blockBackground';
import { classifyDetailsHtmlBlock, matchingDetailsClose, readToggleSummaryHeader } from './toggleSummary';

const text = (value: string, marks?: string[]): DocNode =>
  marks
    ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text: value };
const p = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content });

function hasBlockBackground(node: DocNode): boolean {
  return (
    node.attrs?.backgroundColor !== undefined ||
    (node.content ?? []).some((child) => hasBlockBackground(child))
  );
}

function findBlockBackgroundMarker(source: string): number {
  return source.match(/<!-- morrow:block-background:/g)?.length ?? 0;
}

function resolverForFiles(files: Array<{ id: PageId; path: string | null }>): Resolver {
  const pages = Object.fromEntries(
    files.map(({ id, path }) => [
      id,
      {
        id,
        title:
          path
            ?.split('/')
            .pop()
            ?.replace(/\.(md|canvas)$/i, '') ?? id,
        trashedAt: null,
      },
    ]),
  );
  const layout = new Map<PageId, Placement>(
    files.map(({ id, path }) => [id, { file: path, folder: path?.replace(/\.(md|canvas)$/i, '') ?? id }]),
  );
  return makeResolver({ pages } as unknown as WorkspaceState, layout, new Map());
}

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

  it('keeps a toggle heading through a save and load', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: false },
          content: [
            { type: 'detailsSummary', attrs: { level: 2 }, content: [text('Section')] },
            { type: 'detailsContent', content: [p(text('Inside'))] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<summary><h2>Section</h2></summary>');
    const summary = markdownToDoc(markdown).content![0]!.content![0]!;
    expect(summary).toEqual({ type: 'detailsSummary', attrs: { level: 2 }, content: [text('Section')] });
  });

  it('keeps the width of a resized picture the way obsidian writes it', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'image', attrs: { fileId: null, src: 'cat.png', alt: 'A cat', width: 320 } }],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toBe('![A cat|320](cat.png)\n');
    expect(markdownToDoc(markdown).content![0]!.attrs).toEqual({
      fileId: null,
      src: 'cat.png',
      alt: 'A cat',
      width: 320,
    });
    expect(markdownToDoc('![2024 trip](trip.png)\n').content![0]!.attrs?.alt).toBe('2024 trip');
  });

  it('keeps a toggle open or closed through a save and load', () => {
    const toggle = (open: boolean): DocNode => ({
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open },
          content: [
            { type: 'detailsSummary', content: [text('Section')] },
            { type: 'detailsContent', content: [p(text('Inside'))] },
          ],
        },
      ],
    });
    expect(markdownToDoc(docToMarkdown(toggle(true))).content![0]!.attrs).toEqual({ open: true });
    expect(markdownToDoc(docToMarkdown(toggle(false))).content![0]!.attrs).toEqual({ open: false });
  });

  it('keeps links and bold in a toggle title through a save and load', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: false },
          content: [
            {
              type: 'detailsSummary',
              content: [
                text('See '),
                {
                  type: 'text',
                  text: 'the docs',
                  marks: [{ type: 'link', attrs: { href: 'https://example.org/a?b=1&c=2' } }],
                },
                text(' '),
                text('now', ['bold']),
              ],
            },
            { type: 'detailsContent', content: [p(text('Inside'))] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('data-morrow-summary-format="markdown"');
    const summary = markdownToDoc(markdown).content![0]!.content![0]!;
    expect(summary.content).toEqual([
      text('See '),
      {
        type: 'text',
        text: 'the docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.org/a?b=1&c=2' } }],
      },
      text(' '),
      text('now', ['bold']),
    ]);
  });

  it('round trips a published HEX title background, links, marks, heading and open state', () => {
    const source = `<details open>
<summary data-block-background="#1A2B3C" data-morrow-summary-format="markdown"><h3>See **bold** [the plan](https://example.org/plan?a=1&b=2) and [[Other|internal]]</h3></summary>

Inside.

</details>
`;
    const options = { resolvePage: (target: string) => (target === 'Other' ? 'other-page' : null) };
    const parsed = markdownToDoc(source, options);
    const toggle = parsed.content![0]!;
    const summary = toggle.content![0]!;
    expect(toggle.attrs?.open).toBe(true);
    expect(summary.attrs).toEqual({ level: 3, backgroundColor: '#1a2b3c' });
    expect(summary.content).toEqual([
      text('See '),
      text('bold', ['bold']),
      text(' '),
      {
        type: 'text',
        text: 'the plan',
        marks: [{ type: 'link', attrs: { href: 'https://example.org/plan?a=1&b=2' } }],
      },
      text(' and '),
      { type: 'pageLink', attrs: { id: 'other-page', label: 'internal', alias: 'internal' } },
    ]);

    const markdown = docToMarkdown(parsed, { linkTarget: (id) => (id === 'other-page' ? 'Other' : null) });
    expect(markdown).toContain(
      '<summary data-block-background="#1a2b3c" data-morrow-summary-format="markdown"><h3>',
    );
    expect(markdownToDoc(markdown, options)).toEqual(parsed);
  });

  it('round trips code literals, literal entities, underline, highlight and color in a toggle title', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: true },
          content: [
            {
              type: 'detailsSummary',
              attrs: { level: 2, backgroundColor: '#1a2b3c' },
              content: [
                text('HTML-looking code: '),
                {
                  type: 'text',
                  text: '</summary> </details> &lt; &amp;',
                  marks: [{ type: 'code' }],
                },
                text(' and literal entity &lt;; plain </summary> after and </details> after; '),
                { type: 'text', text: 'underlined', marks: [{ type: 'underline' }] },
                text(', '),
                {
                  type: 'text',
                  text: 'highlighted',
                  marks: [{ type: 'highlight', attrs: { color: '#abcdef' } }],
                },
                text(', '),
                {
                  type: 'text',
                  text: 'colored',
                  marks: [{ type: 'textColor', attrs: { color: '#fedcba' } }],
                },
              ],
            },
            { type: 'detailsContent', content: [p(text('Body'))] },
          ],
        },
      ],
    };

    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('`</summary> </details> &lt; &amp;`');
    expect(markdown).toContain('plain \\</summary> after and \\</details> after');
    expect(markdown).toContain('<u>underlined</u>');
    expect(markdown).toContain('<mark style="background: #abcdef">highlighted</mark>');
    expect(markdown).toContain('<span style="color: #fedcba">colored</span>');
    expect(markdownToDoc(markdown)).toEqual(doc);
  });

  it('uses backslash parity to distinguish escaped tag text from real summary tags', () => {
    const oddEscaped = `<details>\n<summary>Odd: \\</summary> after</summary>\n\nBody\n\n</details>`;
    const oddHeader = readToggleSummaryHeader(oddEscaped);
    expect(oddHeader).not.toBeNull();
    expect(oddEscaped.slice(oddHeader!.titleStart, oddHeader!.titleEnd)).toBe('Odd: \\</summary> after');

    const evenEscaped = `<details>\n<summary>Even: \\\\</summary>\n\nBody\n\n</details>`;
    const evenHeader = readToggleSummaryHeader(evenEscaped);
    expect(evenHeader).not.toBeNull();
    expect(evenEscaped.slice(evenHeader!.titleStart, evenHeader!.titleEnd)).toBe('Even: \\\\');
  });

  it('keeps source after a details close tag when it cannot be attached to the toggle', () => {
    const suffix = '<span data-keep="yes">Tail</span>';
    const source = `<details>\n<summary>Title</summary>\n\nBody.\n\n</details>${suffix}\n`;
    expect(markdownToDoc(source).content?.[1]).toEqual({ type: 'rawBlock', attrs: { text: suffix } });
  });

  it.each([
    ['without summary metadata', '<summary>Title</summary>'],
    ['with a styled summary', '<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>'],
  ])('keeps a raw HTML close after a backslash outside the toggle %s', (_name, summary) => {
    const source = `<details open>\n${summary}\n\n<p>Path</p>\\</details>\n\nOutside\n`;
    const parsed = markdownToDoc(source);
    const toggle = parsed.content?.[0];
    expect(toggle?.type).toBe('details');
    expect(JSON.stringify(toggle?.content?.[1])).toContain('<p>Path</p>');
    expect(JSON.stringify(toggle?.content?.[1])).not.toContain('Outside');
    expect(parsed.content?.[1]).toEqual({ type: 'paragraph', content: [text('Outside')] });
  });

  it('does not treat a details close inside raw-text HTML as structural', () => {
    const source = `<details open>\n<summary data-block-background="#1a2b3c"><h2>Title</h2></summary>\n\n<textarea>literal </details></textarea>\n\nInside toggle.\n\n</details>\n\nOutside\n`;
    const parsed = markdownToDoc(source);
    const toggle = parsed.content?.[0];
    expect(toggle?.type).toBe('details');
    expect(toggle?.attrs?.open).toBe(true);
    expect(toggle?.content?.[1]?.content?.[0]).toEqual({
      type: 'rawBlock',
      attrs: { text: '<textarea>literal </details></textarea>' },
    });
    expect(toggle?.content?.[1]?.content?.[1]).toEqual({ type: 'paragraph', content: [text('Inside toggle.')] });
    expect(parsed.content?.[1]).toEqual({ type: 'paragraph', content: [text('Outside')] });
    expect(markdownToDoc(docToMarkdown(parsed))).toEqual(parsed);
  });

  it.each(['textarea', 'title', 'script', 'style', 'iframe', 'noembed', 'noframes', 'noscript', 'xmp'])(
    'skips an embedded details close inside raw-text <%s>',
    (element) => {
      const source = `<${element}>literal </details></${element}>\n</details>\n`;
      const closing = matchingDetailsClose(source);
      expect(closing).not.toBeNull();
      expect(source.slice(closing!.start, closing!.end)).toBe('</details>');
    },
  );

  it('does not scan past comments or unterminated opaque input for a details close', () => {
    const commented = `<!-- literal </details> -->\n</details>`;
    const close = matchingDetailsClose(commented);
    expect(close).not.toBeNull();
    expect(commented.slice(close!.start, close!.end)).toBe('</details>');
    expect(matchingDetailsClose('<!-- no comment end </details>')).toBeNull();
    expect(matchingDetailsClose('<plaintext>literal </details>')).toBeNull();
  });

  it('classifies wrapper-owned and self-closing details tags as raw HTML', () => {
    const wrapper = '<div>\n<details>\n</div>';
    expect(classifyDetailsHtmlBlock(wrapper, false).kind).toBe('raw');
    expect(classifyDetailsHtmlBlock('<details/>', false).kind).toBe('raw');
    expect(classifyDetailsHtmlBlock('<details>', false).kind).toBe('open');
    expect(markdownToDoc(wrapper).content?.[0]).toEqual({ type: 'rawBlock', attrs: { text: wrapper } });
  });

  it('reports details ownership from the builder without treating quote raw HTML as a close', () => {
    const source = `<details open>\n<summary>Toggle</summary>\n\nBefore.\n\n> </details>\n\n<!-- comment without an end\n`;
    const parsed = markdownToDocWithDetailsHtmlBlocks(source);
    const quotedClose = parsed.detailsHtmlBlocks.find((block) => block.source.includes('</details>'));
    const unfinishedComment = parsed.detailsHtmlBlocks.find((block) => block.source.includes('<!-- comment'));

    expect(quotedClose).toMatchObject({
      structure: { kind: 'raw' },
      detailsOwner: true,
      immediateDetailsOwner: false,
    });
    expect(unfinishedComment).toMatchObject({
      structure: { kind: 'raw' },
      detailsOwner: true,
      immediateDetailsOwner: true,
    });
    expect(parsed.doc.content?.[0]?.type).toBe('details');
  });

  it('ignores close-tag text in inline code when reading a styled summary and its details close', () => {
    const source = `<details open>
<summary data-block-background="#2f80ed">Code: \`</summary>\` and \`</details>\` **title**</summary>

Body.

</details>
`;
    const parsed = markdownToDoc(source);
    const toggle = parsed.content![0]!;
    const summary = toggle.content![0]!;
    expect(toggle.attrs?.open).toBe(true);
    expect(summary.attrs?.backgroundColor).toBe('#2f80ed');
    expect(summary.content).toEqual([
      text('Code: '),
      text('</summary>', ['code']),
      text(' and '),
      text('</details>', ['code']),
      text(' '),
      text('title', ['bold']),
    ]);
    expect(toggle.content?.[1]?.content?.[0]?.content?.[0]?.text).toBe('Body.');
  });

  it('keeps native H4-H6 details summary levels', () => {
    for (const level of [4, 5, 6]) {
      const parsed = markdownToDoc(`<details><summary><h${level}>Native</h${level}></summary>\n\nBody\n\n</details>`);
      expect(parsed.content?.[0]?.content?.[0]?.attrs?.level).toBe(level);
    }
  });

  it('refuses unsupported details summary content instead of silently serializing it', () => {
    expect(() =>
      docToMarkdown({
        type: 'doc',
        content: [
          {
            type: 'details',
            content: [
              { type: 'detailsSummary', content: [{ type: 'inlineMath', attrs: { latex: 'x' } }] },
              { type: 'detailsContent', content: [p(text('Body'))] },
            ],
          },
        ],
      }),
    ).toThrow(/toggle summaries can contain only text and non-embedded page links/i);
  });

  it('keeps a callout icon, or no icon, in its obsidian metadata', () => {
    const callout = (attrs: Record<string, unknown>): DocNode => ({
      type: 'doc',
      content: [{ type: 'callout', attrs: { tone: 'tip', kind: 'tip', ...attrs }, content: [p(text('Hi'))] }],
    });
    const fire = docToMarkdown(callout({ icon: '🔥' })).trimEnd();
    expect(fire).toBe('> [!tip|icon:🔥]\n> Hi');
    expect(markdownToDoc(fire).content![0]!.attrs).toMatchObject({ kind: 'tip', icon: '🔥' });
    const none = markdownToDoc(docToMarkdown(callout({ icon: 'none' }))).content![0]!;
    expect(none.attrs?.icon).toBe('none');
    const wide = markdownToDoc('> [!note|wide]- Folded\n> Body').content![0]!;
    expect(wide.attrs).toMatchObject({ meta: 'wide', fold: '-', title: 'Folded' });
    expect(docToMarkdown({ type: 'doc', content: [wide] }).trimEnd()).toBe('> [!note|wide]- Folded\n> Body');
  });

  it('keeps a table header column through a save and load', () => {
    const cell = (type: string, value: string): DocNode => ({ type, content: [p(text(value))] });
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Age')] },
            { type: 'tableRow', content: [cell('tableHeader', 'Ada'), cell('tableCell', '36')] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown.startsWith('<!-- header-column -->\n| Name |')).toBe(true);
    const row = markdownToDoc(markdown).content![0]!.content![1]!;
    expect(row.content!.map((c) => c.type)).toEqual(['tableHeader', 'tableCell']);
    expect(
      markdownToDoc('| a | b |\n| --- | --- |\n| c | d |').content![0]!.content![1]!.content![0]!.type,
    ).toBe('tableCell');
  });

  it('keeps lists and pictures inside table cells through a save and load', () => {
    const item = (type: string, value: string, ...rest: DocNode[]): DocNode => ({
      type,
      ...(type === 'taskItem' ? { attrs: { checked: value === 'done' } } : {}),
      content: [p(text(value)), ...rest],
    });
    const cells: DocNode[][] = [
      [p(text('Plan'))],
      [
        p(text('Before')),
        {
          type: 'bulletList',
          content: [item('listItem', 'one', { type: 'bulletList', content: [item('listItem', 'nested')] })],
        },
        p(text('After')),
      ],
      [
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [item('listItem', 'three'), item('listItem', 'four')],
        },
      ],
      [{ type: 'taskList', content: [item('taskItem', 'done'), item('taskItem', 'todo')] }],
      [{ type: 'image', attrs: { fileId: null, src: 'attachments/cat.png', alt: 'cat' } }],
    ];
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: cells.map(() => ({ type: 'tableHeader', content: [p(text('h'))] })),
            },
            { type: 'tableRow', content: cells.map((content) => ({ type: 'tableCell', content })) },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown.trimEnd().split('\n')).toHaveLength(3);
    const row = markdownToDoc(markdown).content![0]!.content![1]!;
    expect(row.content!.map((cell) => cell.content)).toEqual(cells);
    // and it is still the same after a second save
    expect(docToMarkdown(markdownToDoc(markdown))).toBe(markdown);
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

  it('splits mixed task and bullet lists', () => {
    const doc = markdownToDoc('- [ ] task\n- plain\n- [x] done\n- [ ]');
    expect(doc.content!.map((node) => node.type)).toEqual(['taskList', 'bulletList', 'taskList']);
    expect(doc.content![2]!.content).toHaveLength(2);
  });

  it('handles empty and hostile input', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(() => markdownToDoc('>'.repeat(5000))).not.toThrow();
    expect(() => markdownToDoc('['.repeat(10000))).not.toThrow();
  });
});

describe('inline Markdown page links', () => {
  const resolver = resolverForFiles([
    { id: 'target', path: 'Notes/Árvore#.md' },
    { id: 'diagram', path: 'Targets/Diagram.canvas' },
    { id: 'diagram-note', path: 'Targets/Diagram.md' },
    { id: 'left-note', path: 'Left/Note.md' },
    { id: 'right-note', path: 'Right/Note.md' },
    { id: 'case-one', path: 'Case/Collision.md' },
    { id: 'case-two', path: 'case/collision.md' },
    { id: 'split-path', path: 'Notes/A/T.md' },
    { id: 'encoded-host', path: 'example.com/T.md' },
    { id: 'backslash-path', path: 'Notes/A\\B.md' },
    { id: 'folder', path: null },
  ]);

  it('scans a bounded inline destination without normalizing its source spelling', () => {
    const source = '[label](<./Árvore%23.md?q=1&amp;x=%2f#Seção%2F> "title")';
    const openingParenOffset = source.indexOf('(');
    const scan = scanMarkdownDestination(source, openingParenOffset, source.length);

    expect(scan).not.toBeNull();
    expect(source.slice(scan!.start, scan!.end)).toBe('./Árvore%23.md?q=1&amp;x=%2f#Seção%2F');
    expect(source[scan!.close]).toBe(')');
    expect(scanMarkdownDestination(source, openingParenOffset, 8)).toBeNull();
    expect(scanMarkdownDestination(source, source.length, 100)).toBeNull();
    expect(scanMarkdownDestination('[x](./T.md?q=a\\ b#f)', 3, 100)).toBeNull();
    expect(scanMarkdownDestination('[x](./T.md?q=a\u0001b#f)', 3, 100)).toBeNull();
  });

  it('resolves only a unique full file path after splitting suffix delimiters', () => {
    expect(resolveMarkdownPageLink('../Notes/%C3%81rvore%23.md?q=1#Section', 'Docs', resolver)).toBe(
      'target',
    );
    expect(resolveMarkdownPageLink('/Notes/%C3%81rvore%23.md?q=1#Section', 'Docs', resolver)).toBe('target');
    expect(resolveMarkdownPageLink('Targets/Diagram.canvas', '', resolver)).toBe('diagram');
    expect(resolveMarkdownPageLink('Targets/Diagram.md', '', resolver)).toBe('diagram-note');
    expect(resolveMarkdownPageLink('Note.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('Case/Collision.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('Folder.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('../../Outside.md', 'Docs', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('A%2FT.md', 'Notes', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('%2F%2Fexample.com/T.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('A%5CB.md', 'Notes', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('https://example.org/Notes/Árvore.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('//example.org/Notes/Árvore.md', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('#heading', '', resolver)).toBeNull();
    expect(resolveMarkdownPageLink('?mode=compact', '', resolver)).toBeNull();
  });

  it('uses Markdown entity semantics for path lookup while leaving the raw suffix intact', () => {
    const entityResolver = resolverForFiles([
      { id: 'semantic-path', path: 'Notes/A&B.md' },
      { id: 'literal-entity', path: 'Notes/A&amp;B.md' },
    ]);
    const rawHref = './A&amp;B.md?view=compact&amp;mode=raw#Section';

    expect(markdownHrefPath(rawHref)).toEqual({
      path: './A&B.md',
      suffix: '?view=compact&amp;mode=raw#Section',
    });
    expect(resolveMarkdownPageLink(rawHref, 'Notes', entityResolver)).toBe('semantic-path');

    const source = `[link](${rawHref})`;
    const parse = (markdown: string) =>
      markdownToDoc(markdown, {
        resolveMarkdownPageLink: (href) => resolveMarkdownPageLink(href, 'Notes', entityResolver),
      });
    const first = parse(source);
    const serialized = docToMarkdown(first);
    const reopened = parse(serialized);

    expect(first.content![0]!.content![0]!.attrs).toMatchObject({
      id: 'semantic-path',
      markdownHref: rawHref,
    });
    expect(reopened.content![0]!.content![0]!.attrs).toMatchObject({
      id: 'semantic-path',
      markdownHref: rawHref,
    });
    expect(docToMarkdown(reopened)).toBe(serialized);
  });

  it('keeps the original href, label and decoded anchor on a resolved page link', () => {
    const rawHref = './Árvore%23.md?q=1&amp;token=%2f#Seção%2F';
    const source = `[open section](${rawHref})`;
    const doc = markdownToDoc(source, {
      resolveMarkdownPageLink: (href) => resolveMarkdownPageLink(href, 'Notes', resolver),
      // A strict miss must not fall through to the older fuzzy path resolver.
      resolveLink: () => 'wrong-page',
    });
    const link = doc.content![0]!.content![0]!;

    expect(link).toEqual({
      type: 'pageLink',
      attrs: {
        id: 'target',
        label: 'open section',
        alias: 'open section',
        markdownHref: rawHref,
        anchor: 'Seção/',
      },
    });
    expect(docToMarkdown(doc)).toBe(`${source}\n`);
  });

  it('escapes entity-like page labels so a reopened link shows the same text', () => {
    const source = '[X &amp;copy;](./T.md?q=1#Topic)';
    const resolve = () => 'target';
    const first = markdownToDoc(source, { resolveMarkdownPageLink: resolve });
    const originalLink = first.content![0]!.content![0]!;
    const serialized = docToMarkdown(first);
    const reopened = markdownToDoc(serialized, { resolveMarkdownPageLink: resolve });
    const reopenedLink = reopened.content![0]!.content![0]!;

    expect(originalLink.attrs?.alias).toBe('X &copy;');
    expect(serialized).toBe('[X \\&copy;](./T.md?q=1#Topic)\n');
    expect(reopenedLink.attrs?.alias).toBe('X &copy;');
    expect(reopenedLink.attrs?.markdownHref).toBe('./T.md?q=1#Topic');
    expect(docToMarkdown(reopened)).toBe(serialized);
  });

  it.each([
    ['greater-than escape', '[ref](<./T.md?q=a\\>b#Topic>)', './T.md?q=a\\>b#Topic'],
    ['less-than escape', '[ref](<./T.md?q=a\\<b#Topic>)', './T.md?q=a\\<b#Topic'],
  ])('preserves an escaped angle glyph in the raw href (%s)', (_label, source, rawHref) => {
    const resolve = () => 'target';
    const first = markdownToDoc(source, { resolveMarkdownPageLink: resolve });
    const serialized = docToMarkdown(first);
    const reopened = markdownToDoc(serialized, { resolveMarkdownPageLink: resolve });
    const originalLink = first.content![0]!.content![0]!;
    const reopenedLink = reopened.content![0]!.content![0]!;

    expect(originalLink.attrs?.markdownHref).toBe(rawHref);
    expect(reopenedLink.attrs?.markdownHref).toBe(rawHref);
    expect(reopenedLink.attrs?.anchor).toBe('Topic');
    expect(serialized).not.toContain('%3E');
    expect(serialized).not.toContain('%3C');
    expect(docToMarkdown(reopened)).toBe(serialized);
  });

  it.each([
    ['less-than', '[ref](./T.md?q=a<b(c)#f)', './T.md?q=a<b(c)#f'],
    ['greater-than', '[ref](./T.md?q=a>b(c)#f)', './T.md?q=a>b(c)#f'],
  ])('preserves a bare href with balanced parentheses and %s (%s)', (_glyph, source, rawHref) => {
    const resolve = () => 'target';
    const first = markdownToDoc(source, { resolveMarkdownPageLink: resolve });
    const serialized = docToMarkdown(first);
    const reopened = markdownToDoc(serialized, { resolveMarkdownPageLink: resolve });

    expect(first.content![0]!.content![0]!.attrs?.markdownHref).toBe(rawHref);
    expect(serialized).toBe(`${source}\n`);
    expect(reopened.content![0]!.content![0]!.attrs?.markdownHref).toBe(rawHref);
    expect(docToMarkdown(reopened)).toBe(serialized);
  });

  it('keeps an angle-delimited href containing an escaped space on a repeated save', () => {
    const source = '[x](<./T.md?q=a\\ b#f>)';
    const rawHref = './T.md?q=a\\ b#f';
    const resolve = () => 'target';
    const first = markdownToDoc(source, { resolveMarkdownPageLink: resolve });
    const serialized = docToMarkdown(first);
    const reopened = markdownToDoc(serialized, { resolveMarkdownPageLink: resolve });

    expect(first.content![0]!.content![0]!.attrs?.markdownHref).toBe(rawHref);
    expect(serialized).toBe(`${source}\n`);
    expect(reopened.content![0]!.content![0]!.attrs?.markdownHref).toBe(rawHref);
    expect(docToMarkdown(reopened)).toBe(serialized);
  });

  it('loads a source-relative page file link by its unique Markdown file path', () => {
    const rawHref = './Target%23page.md?view=compact#Section%2F';
    const vault: VaultScan = {
      files: [
        {
          path: 'Notes/Source.md',
          text: `[target](${rawHref}) [ambiguous](Note.md)`,
          mtime: 1,
          birthtime: 1,
        },
        { path: 'Notes/Target#page.md', text: '', mtime: 1, birthtime: 1 },
        { path: 'Left/Note.md', text: '', mtime: 1, birthtime: 1 },
        { path: 'Right/Note.md', text: '', mtime: 1, birthtime: 1 },
      ],
      folders: [],
      others: [],
      registry: null,
      recent: null,
    };
    let nextId = 0;
    const loaded = loadVault(vault, () => `loaded-${++nextId}`, 1);
    const idAt = (path: string) => [...loaded.layout].find(([, placement]) => placement.file === path)?.[0];
    const source = loaded.docs[idAt('Notes/Source.md')!]!;
    const nodes = source.content![0]!.content!;

    expect(nodes[0]!.attrs).toMatchObject({
      id: idAt('Notes/Target#page.md'),
      label: 'target',
      alias: 'target',
      markdownHref: rawHref,
      anchor: 'Section/',
    });
    expect(nodes[2]!.type).toBe('text');
    expect(nodes[2]!.marks?.find((mark) => mark.type === 'link')?.attrs?.href).toBe('Note.md');
  });

  it('leaves external, fragment-only, query-only and ambiguous links as ordinary links', () => {
    const source =
      '[external](https://example.org/page) [heading](#intro) [query](?view=1) [ambiguous](Note.md)';
    const doc = markdownToDoc(source, {
      resolveMarkdownPageLink: (href) => resolveMarkdownPageLink(href, '', resolver),
      resolveLink: () => 'wrong-page',
    });
    const links = doc.content![0]!.content!.filter((node) =>
      node.marks?.some((mark) => mark.type === 'link'),
    );

    expect(links.map((node) => node.marks?.find((mark) => mark.type === 'link')?.attrs?.href)).toEqual([
      'https://example.org/page',
      '#intro',
      '?view=1',
      'Note.md',
    ]);
    expect(links.every((node) => node.type === 'text')).toBe(true);
    expect(docToMarkdown(doc)).toBe(`${source}\n`);
  });

  it('does not resolve inline-looking text inside code', () => {
    const doc = markdownToDoc('`[code](Notes/Árvore%23.md)`\n\n```md\n[code](Notes/Árvore%23.md)\n```', {
      resolveMarkdownPageLink: () => 'wrong-page',
    });

    expect(doc.content![0]!.content).toEqual([
      { type: 'text', text: '[code](Notes/Árvore%23.md)', marks: [{ type: 'code' }] },
    ]);
    expect(doc.content![1]!.type).toBe('codeBlock');
    expect(doc.content![1]!.content?.[0]?.text).toBe('[code](Notes/Árvore%23.md)');
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
  it('reads the exact standalone legacy block marker on supported blocks and native columns', () => {
    const marker = '<!-- morrow:block-background:#2F80ED -->';
    const source = [
      marker,
      'Shaded paragraph.',
      '',
      '<!-- morrow:block-background:green -->',
      '## Shaded heading',
      '',
      '<!-- morrow:block-background:blue -->',
      '> Shaded quote',
      '',
      '<!-- background: red -->',
      'Current named format.',
      '',
      '<div data-columns>',
      '<div data-column>',
      '',
      marker,
      '',
      'Shaded column paragraph.',
      '',
      '</div>',
      '</div>',
      '',
    ].join('\n');
    const doc = markdownToDoc(source);
    const inspections = inspectBlockBackgroundMarkers(source);
    expect(inspections).toHaveLength(4);
    expect(inspections.every((marker) => marker.approved && marker.color)).toBe(true);
    expect(doc.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'heading',
      'blockquote',
      'paragraph',
      'columns',
    ]);
    expect(doc.content?.[0]?.attrs?.backgroundColor).toBe('#2f80ed');
    expect(doc.content?.[1]?.attrs?.backgroundColor).toBe('green');
    expect(doc.content?.[2]?.attrs?.backgroundColor).toBe('blue');
    expect(doc.content?.[3]?.attrs?.backgroundColor).toBe('red');
    expect(doc.content?.[4]?.content?.[0]?.content?.[0]?.attrs?.backgroundColor).toBe('#2f80ed');
    const serialized = docToMarkdown(doc);
    expect(serialized).toContain('<!-- morrow:block-background:#2f80ed -->');
    expect(serialized).toContain('<!-- background: green -->');
    expect(serialized).toContain('<!-- background: blue -->');
    expect(serialized).toContain('<!-- background: red -->');
    expect(findBlockBackgroundMarker(serialized)).toBe(2);
    expect(markdownToDoc(serialized)).toEqual(doc);
  });

  it('does not interpret orphaned, duplicate, inline, fenced, cell, task-first, or details markers', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const cases = [
      marker,
      `${marker}\n\n${marker}\n\nDuplicate target.`,
      `Inline ${marker} text.`,
      `\`\`\`markdown\n${marker}\n\`\`\``,
      `| ${marker} |\n| --- |\n| Cell |`,
      `- \n  ${marker}\n\n  [ ] First task paragraph.`,
      `- \n  <!-- morrow:block-background:green -->\n\n  [ ] First task paragraph.`,
      `<details>\n<summary>Hidden</summary>\n\n${marker}\n\nInside.\n\n</details>`,
    ];
    for (const source of cases) {
      const doc = markdownToDoc(source);
      expect(hasBlockBackground(doc), source).toBe(false);
    }
  });

  it('recognizes direct paragraphs in simple, numbered, nested, and later task list positions', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const source = [
      '- ',
      `  ${marker}`,
      '  First bullet paragraph.',
      '',
      '3. Numbered item',
      '',
      `   ${marker}`,
      '',
      '   Numbered follow-up.',
      '',
      '- Parent item',
      '  - Nested first paragraph.',
      '',
      `    ${marker}`,
      '',
      '    Nested follow-up.',
      '',
      '- [ ] Task title',
      '',
      `  ${marker}`,
      '',
      '  Later task paragraph.',
      '',
      '- ',
      `  ${marker}`,
      '  <br>',
      '',
    ].join('\n');
    const doc = markdownToDoc(source);
    const inspections = inspectBlockBackgroundMarkers(source);
    expect(inspections).toHaveLength(5);
    expect(inspections.every((inspection) => inspection.approved)).toBe(true);
    const paragraph = (node: DocNode) =>
      node.type === 'paragraph' && node.attrs?.backgroundColor === '#2f80ed';
    expect(paragraph(doc.content![0]!.content![0]!.content![0]!)).toBe(true);
    expect(paragraph(doc.content![1]!.content![0]!.content![1]!)).toBe(true);
    expect(paragraph(doc.content![2]!.content![0]!.content![1]!.content![0]!.content![1]!)).toBe(true);
    expect(doc.content![3]!.type).toBe('taskList');
    expect(paragraph(doc.content![3]!.content![0]!.content![1]!)).toBe(true);
    expect(paragraph(doc.content![4]!.content![0]!.content![0]!)).toBe(true);
    expect(markdownToDoc(docToMarkdown(doc))).toEqual(doc);
  });

  it('proves the normalized marker owner after embeds and callouts are converted', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const resolveFile = (href: string) =>
      href === 'assets/a.png' || href === 'assets/a.pdf'
        ? { fileId: href, name: href.split('/').at(-1)!, image: href.endsWith('.png') }
        : null;
    const unstable = [
      `${marker}\n\n![[assets/a.png]]\n`,
      `${marker}\n\nLeft ![[assets/a.png]] right\n`,
      `> [!note] Header\n>\n> ${marker}\n> Body\n`,
    ];
    for (const source of unstable) {
      expect(inspectBlockBackgroundMarkers(source, (href) => resolveFile(href) !== null)[0]?.approved).toBe(
        false,
      );
      expect(hasBlockBackground(markdownToDoc(source, { resolveFile })), source).toBe(false);
    }

    const represented = `${marker}\n\nRead [the file](assets/a.pdf) safely.\n`;
    expect(
      inspectBlockBackgroundMarkers(represented, (href) => resolveFile(href) !== null)[0]?.approved,
    ).toBe(true);
    expect(markdownToDoc(represented, { resolveFile }).content?.[0]?.attrs?.backgroundColor).toBe('#2f80ed');
  });

  it('refuses custom backgrounds on items and task first paragraphs, not direct list paragraphs', () => {
    const paragraph = { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [text('No')] };
    const docs: DocNode[] = [
      {
        type: 'doc',
        content: [
          {
            type: 'taskList',
            content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph] }],
          },
        ],
      },
      {
        type: 'doc',
        content: [{ type: 'details', content: [{ type: 'detailsContent', content: [paragraph] }] }],
      },
      {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph] }] }],
          },
        ],
      },
      {
        type: 'doc',
        content: [{ type: 'listItem', attrs: { backgroundColor: '#2f80ed' }, content: [p(text('No'))] }],
      },
    ];
    for (const doc of docs) expect(() => docToMarkdown(doc)).toThrow(/custom block backgrounds/i);
  });

  it('refuses a palette background on the first task paragraph', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', attrs: { backgroundColor: 'green' }, content: [text('First')] }],
            },
          ],
        },
      ],
    };
    expect(() => docToMarkdown(doc)).toThrow(/palette backgrounds.*task first paragraph/i);
  });

  it('round trips paragraph backgrounds beside independent list-item palette backgrounds', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [
                { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [text('First')] },
                p(text('Plain follow-up')),
                {
                  type: 'paragraph',
                  attrs: { backgroundColor: 'green' },
                  content: [text('Named follow-up')],
                },
                { type: 'paragraph', attrs: { backgroundColor: '#12ab34' }, content: [] },
              ],
            },
            {
              type: 'listItem',
              content: [
                p(text('Parent')),
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [
                        {
                          type: 'paragraph',
                          attrs: { backgroundColor: '#2f80ed' },
                          content: [text('Nested')],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true, backgroundColor: 'blue' },
              content: [
                p(text('Task first line')),
                {
                  type: 'paragraph',
                  attrs: { backgroundColor: '#12ab34' },
                  content: [text('Task follow-up')],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toContain(`- \n  ${marker}\n\n  First <!-- background: yellow -->`);
    expect(out).toContain('<!-- background: blue -->');
    expect(out).toContain('<!-- morrow:block-background:green -->');
    expect(out).toContain('<!-- morrow:block-background:#12ab34 -->');
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('round trips an empty colored first paragraph with its list-item palette', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [] }],
            },
          ],
        },
      ],
    };

    const source = docToMarkdown(doc);
    expect(source).toBe(`- \n  ${marker}\n\n  <br> <!-- background: yellow -->\n`);
    expect(markdownToDoc(source)).toEqual(doc);
  });

  it('keeps the existing title extraction for a native named background on the first H1', () => {
    const page = markdownToPage('<!-- background: blue -->\n\n# Page title', 'Note');
    expect(page.title).toBe('Page title');
    expect(page.doc.content).toEqual([{ type: 'paragraph' }]);
  });

  it('normalizes only safe legacy marker values', () => {
    expect(parseBlockBackgroundMarker('<!-- morrow:block-background:#2F80ED -->')).toBe('#2f80ed');
    expect(parseBlockBackgroundMarker('<!-- morrow:block-background:green -->')).toBe('green');
    expect(formatBlockBackgroundMarker('#2F80ED')).toBe('<!-- morrow:block-background:#2f80ed -->');
    for (const value of [
      '<!--  morrow:block-background:#2f80ed -->',
      '<!-- morrow:block-background:GREEN -->',
      '<!-- morrow:block-background:#12345 -->',
      '<!-- morrow:block-background:#123456; background:url(javascript:alert(1)) -->',
    ]) {
      expect(parseBlockBackgroundMarker(value)).toBeNull();
    }
  });

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

  it('round trips a block background as a comment above the block', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { ...p(text('Shaded')), attrs: { backgroundColor: 'yellow' } },
        { type: 'heading', attrs: { level: 2, backgroundColor: 'blue' }, content: [text('Title')] },
        p(text('Plain')),
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe('<!-- background: yellow -->\nShaded\n\n<!-- background: blue -->\n## Title\n\nPlain\n');
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('round trips a background on one item of a list at the end of its line', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', attrs: { backgroundColor: 'red' }, content: [p(text('One'))] },
            { type: 'listItem', content: [p(text('Two'))] },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false, backgroundColor: 'blue' },
              content: [p(text('Do'))],
            },
          ],
        },
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe('- One <!-- background: red -->\n- Two\n\n- [ ] Do <!-- background: blue -->\n');
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('round trips a picture set to one side as a comment above it', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: { fileId: null, src: 'https://example.org/a.png', alt: 'a', width: 300, align: 'right' },
        },
      ],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe('<!-- align: right -->\n![a|300](https://example.org/a.png)\n');
    expect(markdownToDoc(out).content![0]!.attrs?.align).toBe('right');
  });

  it('keeps a page shown without its title as a comment above the line', () => {
    const out = '<!-- embed: no title -->\n![[Notes]]\n';
    const doc = markdownToDoc(out);
    expect(doc.content![0]!.attrs?.embedTitle).toBe(false);
    expect(docToMarkdown(doc)).toBe(out);
  });

  it('keeps an html block drawn as a preview as a comment above it', () => {
    const out = '<!-- preview -->\n```html\n<p>Hi</p>\n```\n';
    const doc = markdownToDoc(out);
    expect(doc.content![0]!.type).toBe('codeBlock');
    expect(doc.content![0]!.attrs?.preview).toBe(true);
    expect(docToMarkdown(doc)).toBe(out);
  });

  it('keeps a list counted in letters, numbered in the file', () => {
    const item = (words: string) => ({ type: 'listItem', content: [p(text(words))] });
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'orderedList', attrs: { start: 1, type: 'a' }, content: [item('One'), item('Two')] }],
    };
    const out = docToMarkdown(doc);
    expect(out).toBe('<!-- letters -->\n1. One\n2. Two\n');
    expect(markdownToDoc(out)).toEqual(doc);
  });

  it('leaves a comment with a colour it does not know alone', () => {
    const doc = markdownToDoc('<!-- background: mauve -->\nWords');
    expect(doc.content!.some((node) => node.attrs?.backgroundColor)).toBe(false);
  });

  it('preserves exact six-digit colours and maps legacy short hex to the nearest palette colour', () => {
    const doc = markdownToDoc('<span style="color: #ff0000">alarm</span>');
    expect(doc.content![0]!.content![0]!.marks).toEqual([{ type: 'textColor', attrs: { color: '#ff0000' } }]);

    const legacyShortHex = markdownToDoc('<span style="color: #f00">alarm</span>');
    expect(legacyShortHex.content![0]!.content![0]!.marks).toEqual([
      { type: 'textColor', attrs: { color: 'red' } },
    ]);
  });

  it('preserves exact inline hex values, overlap, and marks inside headings', () => {
    const source = [
      '## <mark style="background: #ABCDEF"><span style="color: #12AB34">Both</span></mark> <span style="color: red">Preset</span>',
      '',
      '<mark style="background-color: #F00">Legacy highlight</mark>',
    ].join('\n');
    const doc = markdownToDoc(source);
    const out = docToMarkdown(doc);

    expect(out).toBe(
      '## <mark style="background: #abcdef"><span style="color: #12ab34">Both</span></mark> <span style="color: #d44c47">Preset</span>\n\n<mark style="background: #fbecdd">Legacy highlight</mark>\n',
    );
    expect(markdownToDoc(out)).toEqual(doc);
    expect(doc.content![0]!.content![0]!.marks).toEqual([
      { type: 'highlight', attrs: { color: '#abcdef' } },
      { type: 'textColor', attrs: { color: '#12ab34' } },
    ]);
  });

  it.each([
    '<span style="color: #1234">bad length</span>',
    '<span style="color: #12345">bad length</span>',
    '<mark style="background: #1234567">bad length</mark>',
    '<span style="color: #123456; background: url(javascript:alert(1))">extra CSS</span>',
    '<mark style="color: #123456">wrong property</mark>',
    '<span style="background: #123456">wrong property</span>',
    '<mark style="background: rgb(1, 2, 3)">non-hex CSS</mark>',
  ])('does not turn unsupported inline color shape into CSS: %s', (source) => {
    const doc = markdownToDoc(source);
    const text = doc.content!.flatMap((block) => block.content ?? []);
    expect(
      text.every(
        (node) => !(node.marks ?? []).some((mark) => ['textColor', 'highlight'].includes(mark.type)),
      ),
    ).toBe(true);
    const saved = docToMarkdown(doc);
    expect(saved).toContain('\\<');
    expect(saved).not.toMatch(/(?<!\\)<(?:span|mark)\s+style=/);
  });

  it('does not serialize an invalid color attribute as CSS', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        p({
          type: 'text',
          text: 'unsafe',
          marks: [
            { type: 'textColor', attrs: { color: '#1234' } },
            { type: 'highlight', attrs: { color: 'red; background: url(javascript:alert(1))' } },
          ],
        }),
      ],
    };
    expect(docToMarkdown(doc)).toBe('unsafe\n');
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
            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Left' }] }] },
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
  it('keeps the time written with a date', () => {
    const doc = markdownToDoc('Feed the cats [[2026-11-10]] 17:05 sharp');
    expect(doc.content![0]!.content).toEqual([
      { type: 'text', text: 'Feed the cats ' },
      { type: 'dateMention', attrs: { date: '2026-11-10', time: '17:05' } },
      { type: 'text', text: ' sharp' },
    ]);
    expect(docToMarkdown(doc)).toBe('Feed the cats [[2026-11-10]] 17:05 sharp\n');
  });

  it('keeps a date a date when that day has a note', () => {
    const doc = markdownToDoc('Feed the cats [[2026-11-10]]', { resolvePage: () => 'daily-note' });
    expect(doc.content![0]!.content![1]).toEqual({ type: 'dateMention', attrs: { date: '2026-11-10' } });
  });

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
});

describe('table column widths', () => {
  it('keeps the widths columns were dragged to in a comment above the table', () => {
    const cell = (type: string, words: string, width?: number) => ({
      type,
      ...(width ? { attrs: { colwidth: [width] } } : {}),
      content: [{ type: 'paragraph', content: [{ type: 'text', text: words }] }],
    });
    const doc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'Name', 240), cell('tableHeader', 'Note')] },
            { type: 'tableRow', content: [cell('tableCell', 'Ada', 240), cell('tableCell', 'Hi')] },
          ],
        },
      ],
    };
    const out = docToMarkdown(doc);
    expect(out.startsWith('<!-- column-widths: 240 0 -->\n| Name | Note |')).toBe(true);
    expect(markdownToDoc(out)).toEqual(doc);
  });
});
