// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocNode } from '../../core/model';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import { PageLink } from './PageLink';

let editors: Editor[] = [];

function makeEditor(content: unknown): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, PageLink],
    content: content as never,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors) editor.destroy();
  editors = [];
});

describe('Markdown page link persistence in the editor', () => {
  it('keeps markdownHref through PageLink HTML mapping and an unrelated editor edit', () => {
    const rawHref = './Árvore%23.md?query=one&amp;mode=%2f#Seção%2F';
    const source = `[open section](${rawHref})`;
    const parsed = markdownToDoc(source, { resolveMarkdownPageLink: () => 'target-page' });
    const editor = makeEditor(parsed);
    const original = editor.getJSON() as DocNode;
    const originalLink = original.content![0]!.content![0]!;

    expect(originalLink.attrs).toMatchObject({
      id: 'target-page',
      label: 'open section',
      alias: 'open section',
      markdownHref: rawHref,
      anchor: 'Seção/',
    });

    const html = editor.getHTML();
    expect(html).toContain('data-markdown-href=');
    expect(html).toContain('data-alias="open section"');
    expect(html).toContain('data-anchor="Seção/"');
    const restored = makeEditor(html).getJSON() as DocNode;
    expect(restored.content![0]!.content![0]!.attrs).toMatchObject(originalLink.attrs!);

    expect(editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' after')).toBe(true);
    const edited = editor.getJSON() as DocNode;
    expect(edited.content![0]!.content![0]!.attrs).toMatchObject(originalLink.attrs!);
    expect(docToMarkdown(edited)).toBe(`${source} after\n`);
  });

  it('keeps an escaped-space destination angle-delimited through the real editor roundtrip', () => {
    const source = '[x](<./T.md?q=a\\ b#f>)';
    const rawHref = './T.md?q=a\\ b#f';
    const parsed = markdownToDoc(source, { resolveMarkdownPageLink: () => 'target-page' });
    const editor = makeEditor(parsed);
    const html = editor.getHTML();
    const restored = makeEditor(html).getJSON() as DocNode;
    const restoredLink = restored.content![0]!.content![0]!;
    const serialized = docToMarkdown(restored);
    const reopened = markdownToDoc(serialized, { resolveMarkdownPageLink: () => 'target-page' });

    expect(html).toContain('data-markdown-href=');
    expect(restoredLink.attrs?.markdownHref).toBe(rawHref);
    expect(serialized).toBe(`${source}\n`);
    expect(reopened.content![0]!.content![0]!.attrs?.markdownHref).toBe(rawHref);
  });
});
