// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import type { DocNode } from '../../core/model';
import { addPluginInlineFormulaPresentation } from '../plugins/registry';
import { mountInlineFormulaResult } from '../../../plugins/polaris-dados/src/ui/inlineFormulaResult';
import { createExtensions } from './extensions';

function marker(options: { readonly name?: string; readonly formula?: string; readonly outputType?: string } = {}): string {
  const name = options.name ?? 'Visible & safe';
  const payload = {
    resultId: 'editor-result',
    pageId: 'finance-note',
    name,
    formula: options.formula ?? '1 + 2',
    bindings: [],
    outputType: options.outputType ?? 'number',
    format: {},
  };
  return `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}" onclick="alert(1)">${name.replaceAll('&', '&amp;')}</span>`;
}

const editors: Editor[] = [];
let removePresentation: (() => void) | null = null;

function make(content: DocNode): Editor {
  const editor = new Editor({
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
  editors.push(editor);
  return editor;
}

function destroyEditor(editor: Editor): void {
  const index = editors.indexOf(editor);
  if (index !== -1) editors.splice(index, 1);
  editor.destroy();
}

afterEach(() => {
  removePresentation?.();
  removePresentation = null;
  for (const editor of editors.splice(0)) editor.destroy();
});

describe('inert legacy formula editor node', () => {
  it('mounts Polaris Dados read-only results, restores fallback on disable, and reopens without changing Markdown', () => {
    const source = marker({ name: 'Legacy total', formula: '2 + 3', outputType: 'auto' });
    const originalMarkdown = docToMarkdown(markdownToDoc(source));
    const contexts: Array<Record<string, unknown>> = [];
    removePresentation = addPluginInlineFormulaPresentation('polaris-dados', (container, context) => {
      contexts.push(context as unknown as Record<string, unknown>);
      return mountInlineFormulaResult(container, context);
    });

    let target = make(markdownToDoc(source));
    const result = target.view.dom.querySelector<HTMLElement>('.legacy-formula-fallback');
    expect(result?.textContent).toBe('5');
    expect(Object.keys(contexts[0]!).sort()).toEqual(['fallback', 'format', 'formula', 'locale', 'outputType']);
    expect(JSON.stringify(contexts[0])).not.toMatch(/resultId|pageId|name|raw|data-morrow-result/);
    expect(docToMarkdown(target.getJSON() as DocNode)).toBe(originalMarkdown);

    removePresentation();
    removePresentation = null;
    expect(result?.textContent).toBe('Legacy total');
    expect(docToMarkdown(target.getJSON() as DocNode)).toBe(originalMarkdown);

    destroyEditor(target);
    target = make(markdownToDoc(source));
    expect(target.view.dom.querySelector('.legacy-formula-fallback')?.textContent).toBe('Legacy total');
    removePresentation = addPluginInlineFormulaPresentation('polaris-dados', mountInlineFormulaResult);
    expect(target.view.dom.querySelector('.legacy-formula-fallback')?.textContent).toBe('5');
    expect(docToMarkdown(target.getJSON() as DocNode)).toBe(originalMarkdown);
  });

  it('restores every mounted result when one cleanup throws and unregisters destroyed readers', () => {
    const source = `${marker({ name: 'First', formula: '2 + 3', outputType: 'auto' })} and ${marker({ name: 'Second', formula: '4 + 5', outputType: 'auto' })}`;
    let firstNode: HTMLElement | null = null;
    let failedCleanupCalls = 0;
    removePresentation = addPluginInlineFormulaPresentation('polaris-dados', (container, context) => {
      firstNode ??= container;
      const cleanup = mountInlineFormulaResult(container, context);
      return () => {
        cleanup();
        if (container === firstNode) {
          failedCleanupCalls++;
          throw new Error('synthetic renderer cleanup failure');
        }
      };
    });

    const target = make(markdownToDoc(source));
    const results = [...target.view.dom.querySelectorAll<HTMLElement>('.legacy-formula-fallback')];
    const presentations = results.map((result) => result.querySelector<HTMLElement>('.legacy-formula-presentation')!);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.textContent)).toEqual(['5', '9']);
    expect(presentations.map((presentation) => presentation.dataset.inlineFormulaState)).toEqual(['calculated', 'calculated']);
    expect(results.every((result) => !result.hasAttribute('data-inline-formula-state'))).toBe(true);

    expect(() => removePresentation?.()).not.toThrow();
    removePresentation = null;
    expect(failedCleanupCalls).toBe(1);
    expect(results.map((result) => result.textContent)).toEqual(['First', 'Second']);
    expect(presentations.every((presentation) => !presentation.hasAttribute('aria-label') && !presentation.hasAttribute('data-inline-formula-state'))).toBe(true);

    removePresentation = addPluginInlineFormulaPresentation('polaris-dados', (container, context) => {
      const cleanup = mountInlineFormulaResult(container, context);
      return () => {
        cleanup();
        if (container === firstNode) throw new Error('synthetic destroy cleanup failure');
      };
    });
    expect(results.map((result) => result.textContent)).toEqual(['5', '9']);
    expect(() => destroyEditor(target)).not.toThrow();
    expect(results.map((result) => result.textContent)).toEqual(['First', 'Second']);

    expect(() => removePresentation?.()).not.toThrow();
    removePresentation = null;
    const reactivated = addPluginInlineFormulaPresentation('polaris-dados', mountInlineFormulaResult);
    expect(results.map((result) => result.textContent)).toEqual(['First', 'Second']);
    reactivated();
  });

  it('preserves the ProseMirror selected-node class while presentation cleanup throws', () => {
    const target = make(markdownToDoc(marker({ name: 'Selected total', formula: '2 + 3', outputType: 'auto' })));
    const wrapper = target.view.dom.querySelector<HTMLElement>('.legacy-formula-fallback')!;
    const presentation = wrapper.querySelector<HTMLElement>('.legacy-formula-presentation')!;
    target.commands.setNodeSelection(1);
    expect(wrapper.classList.contains('ProseMirror-selectednode')).toBe(true);

    const registerThrowingRenderer = () => addPluginInlineFormulaPresentation('polaris-dados', (container, context) => {
      const cleanup = mountInlineFormulaResult(container, context);
      return () => {
        cleanup();
        throw new Error('synthetic renderer cleanup failure');
      };
    });
    removePresentation = registerThrowingRenderer();
    expect(presentation.dataset.inlineFormulaState).toBe('calculated');
    expect(wrapper.hasAttribute('data-inline-formula-state')).toBe(false);

    expect(() => removePresentation?.()).not.toThrow();
    removePresentation = null;
    expect(wrapper.classList.contains('ProseMirror-selectednode')).toBe(true);
    expect(presentation.textContent).toBe('Selected total');
    expect(presentation.hasAttribute('data-inline-formula-state')).toBe(false);

    removePresentation = registerThrowingRenderer();
    expect(presentation.dataset.inlineFormulaState).toBe('calculated');
    expect(() => destroyEditor(target)).not.toThrow();
    expect(presentation.textContent).toBe('Selected total');
    expect(() => removePresentation?.()).not.toThrow();
    removePresentation = null;
  });

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
