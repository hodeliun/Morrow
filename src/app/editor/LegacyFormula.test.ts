// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import type { DocNode } from '../../core/model';
import { createExtensions } from './extensions';

function marker(): string {
  const payload = {
    resultId: 'editor-result',
    pageId: 'finance-note',
    name: 'Visible & safe',
    formula: '1 + 2',
    bindings: [],
    outputType: 'number',
    format: {},
  };
  return `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}" onclick="alert(1)">Visible &amp; safe</span>`;
}

let editor: Editor | null = null;

function make(content: DocNode): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      createPage: () => null,
      renderEmbed: () => {},
    } as never),
    content: content as never,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('inert legacy formula editor node', () => {
  it('renders only the accessible fallback and does not expose active source attributes to HTML copy', () => {
    const target = make(markdownToDoc(`Before ${marker()} after`));
    const node = target.state.doc.firstChild!.child(1);
    const fallback = target.view.dom.querySelector('.legacy-formula-fallback');

    expect(target.schema.nodes.legacyFormula!.spec.atom).toBe(true);
    expect(node.type.name).toBe('legacyFormula');
    expect(fallback?.textContent).toBe('Visible & safe');
    expect((fallback as HTMLElement | null)?.getAttribute('contenteditable')).toBe('false');
    expect(target.getHTML()).toContain('Visible &amp; safe');
    expect(target.getHTML()).not.toContain('data-morrow-result');
    expect(target.getHTML()).not.toContain('onclick');
    expect(target.getText()).toContain('Visible & safe');
  });

  it('rejects editor transactions that move the result into an unsupported heading', () => {
    const before = markdownToDoc(`Before ${marker()} after`);
    const target = make(before);
    const original = target.getJSON();
    const paragraph = target.state.doc.firstChild!;
    const heading = target.schema.nodes.heading!.create(
      { level: 2 },
      paragraph.content,
    );
    const transaction = target.state.tr.replaceWith(0, target.state.doc.content.size, heading);

    target.view.dispatch(transaction);

    expect(target.getJSON()).toEqual(original);
  });

  it('does not allow code marks on the atom and keeps bold and italic neighbors serializable', () => {
    const target = make(markdownToDoc(`a **before** ${marker()} *after* b`));
    const atomStart = 1 + 'a before '.length;
    const original = target.getJSON();

    target.commands.setTextSelection({ from: atomStart, to: atomStart + 1 });
    expect(target.commands.toggleCode()).toBe(true);

    expect(target.getJSON()).toEqual(original);
    target.commands.setTextSelection({ from: 1, to: 2 });
    expect(target.commands.toggleBold()).toBe(true);
    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
    expect(docToMarkdown(original as DocNode)).toContain('**before**');
    expect(docToMarkdown(original as DocNode)).toContain('*after*');
    expect(docToMarkdown(original as DocNode)).toContain(marker());
  });

  it.each([
    ['bold', (target: Editor) => target.commands.toggleBold()],
    ['italic', (target: Editor) => target.commands.toggleItalic()],
    ['strike', (target: Editor) => target.commands.toggleStrike()],
    ['highlight', (target: Editor) => target.commands.toggleHighlight()],
  ])('does not let a selection-only %s command create marks on the atom', (_name, toggle) => {
    const target = make(markdownToDoc(`a${marker()}b`));
    const original = target.getJSON();

    target.commands.setTextSelection({ from: 2, to: 3 });
    expect(toggle(target)).toBe(true);

    expect(target.getJSON()).toEqual(original);
    expect(docToMarkdown(target.getJSON() as DocNode)).toBe(`a${marker()}b\n`);
  });

  it('keeps neighboring text formatting while leaving an atom unmarked and undoable', () => {
    const target = make(markdownToDoc(`a${marker()}b`));
    const original = target.getJSON();

    target.commands.setTextSelection({ from: 1, to: 4 });
    expect(target.commands.toggleBold()).toBe(true);

    const formatted = target.getJSON() as DocNode;
    const paragraph = formatted.content?.[0];
    expect(paragraph?.content?.[0]?.marks?.map((mark) => mark.type)).toEqual(['bold']);
    expect(paragraph?.content?.[1]?.marks).toBeUndefined();
    expect(paragraph?.content?.[2]?.marks?.map((mark) => mark.type)).toEqual(['bold']);
    expect(docToMarkdown(formatted)).toBe(`**a**${marker()}**b**\n`);
    expect(docToMarkdown(markdownToDoc(docToMarkdown(formatted)))).toBe(docToMarkdown(formatted));
    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
  });

  it('keeps a proven source mark on the atom while editing neighboring text', () => {
    const source = `**${marker()}** word`;
    const target = make(markdownToDoc(source));
    const original = target.getJSON();

    expect(docToMarkdown(original as DocNode)).toBe(`${source}\n`);
    target.commands.setTextSelection({ from: 3, to: 7 });
    expect(target.commands.toggleItalic()).toBe(true);

    const edited = target.getJSON() as DocNode;
    expect(edited.content?.[0]?.content?.[0]?.marks?.map((mark) => mark.type)).toEqual(['bold']);
    expect(docToMarkdown(edited)).toBe(`**${marker()}** *word*\n`);
    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
  });

  it('preserves formatting on text immediately before and after the result atom', () => {
    const target = make(markdownToDoc(`a${marker()}b`));
    target.commands.setTextSelection({ from: 1, to: 2 });
    expect(target.commands.toggleBold()).toBe(true);
    target.commands.setTextSelection({ from: 3, to: 4 });
    expect(target.commands.toggleItalic()).toBe(true);

    const serialized = docToMarkdown(target.getJSON() as DocNode);
    expect(serialized).toBe(`**a**${marker()}*b*\n`);
    expect(docToMarkdown(markdownToDoc(serialized))).toBe(serialized);
  });
});
