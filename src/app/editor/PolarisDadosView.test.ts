// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { validateDoc } from '../../core/doc';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import type { DocNode } from '../../core/model';
import { createExtensions } from './extensions';

const DATA: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-editor',
  sourceDatabaseId: 'source-editor',
  title: 'Read only view',
  columnOrder: ['name'],
  filter: null,
};

let editor: Editor | null = null;

function make(content: unknown): Editor {
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

describe('the inert Polaris Dados view editor node', () => {
  it('registers an atom and keeps the saved payload visible with the plugin unavailable', () => {
    const target = make({ type: 'doc', content: [{ type: 'polarisDadosView', attrs: DATA }] });
    const node = target.state.doc.firstChild!;
    const fallback = target.view.dom.querySelector('.polaris-dados-view-fallback');

    expect(target.schema.nodes.polarisDadosView!.spec.atom).toBe(true);
    expect(node.type.name).toBe('polarisDadosView');
    expect(node.toJSON()).toEqual({ type: 'polarisDadosView', attrs: DATA });
    expect(validateDoc(target.getJSON() as DocNode).ok).toBe(true);
    expect(fallback?.textContent).toContain(DATA.title);
    expect(fallback?.textContent).toContain('Linked view unavailable.');
    expect(fallback?.textContent).toContain(DATA.sourceDatabaseId);
    expect(fallback?.querySelector('button, input, select, textarea')).toBeNull();
  });

  it('rejects a transaction that pastes a duplicate view ID before it reaches the document', () => {
    const target = make({ type: 'doc', content: [{ type: 'polarisDadosView', attrs: DATA }] });
    const duplicate = target.schema.nodes.polarisDadosView!.create(DATA);
    const transaction = target.state.tr.insert(target.state.doc.content.size, duplicate);

    target.view.dispatch(transaction);

    expect(target.state.doc.childCount).toBe(1);
    expect(target.getJSON()).toEqual({ type: 'doc', content: [{ type: 'polarisDadosView', attrs: DATA }] });
  });

  it('rejects a pasted marker that cannot start a list item without inventing a paragraph', () => {
    const target = make({ type: 'doc', content: [] });
    const before = target.getJSON();
    const parsed = markdownToDoc(`-\n  ${encodePolarisDadosViewMarker(DATA)}\n`);

    target.commands.insertContent(parsed.content as never);

    expect(target.getJSON()).toEqual(before);
  });

  it('rejects a new raw marker even when replacing an existing protected marker', () => {
    const original = encodePolarisDadosViewMarker(DATA);
    const replacement = encodePolarisDadosViewMarker({ ...DATA, viewId: 'replacement-view' });
    const target = make({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: original } }],
    });
    const node = target.schema.nodes.rawBlock!.create({ text: replacement });
    const transaction = target.state.tr.replaceWith(0, target.state.doc.content.size, node);

    target.view.dispatch(transaction);

    expect(target.getJSON()).toEqual({
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: original } }],
    });
  });

  it('keeps a view parsed after a list item paragraph when opening the editor schema', () => {
    const markdown = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before' }] }, { type: 'polarisDadosView', attrs: DATA }],
            },
          ],
        },
      ],
    });
    const parsed = markdownToDoc(markdown);
    const target = make(parsed);
    const nodes: DocNode[] = [];
    const collect = (node: DocNode) => {
      nodes.push(node);
      node.content?.forEach(collect);
    };
    collect(target.getJSON() as DocNode);

    expect(validateDoc(parsed).ok).toBe(true);
    expect(nodes.find((node) => node.type === 'polarisDadosView')?.attrs).toEqual(DATA);
  });

  it('preserves the canonical marker in the HTML clipboard representation', () => {
    const target = make({ type: 'doc', content: [{ type: 'polarisDadosView', attrs: DATA }] });
    const html = target.getHTML();

    expect(html).toContain('data-morrow-polaris-dados-view');
    expect(html).toContain('morrow:polaris-dados-view:v1:');
    expect(html).toContain('Linked view unavailable.');
  });
});
