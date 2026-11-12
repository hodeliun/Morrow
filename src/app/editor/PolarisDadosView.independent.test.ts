// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorProps } from '@tiptap/pm/view';
import { docToPlainText } from '../../core/doc';
import { encodePolarisDadosViewMarker } from '../../core/polarisDadosView';
import type { DocNode } from '../../core/model';
import { createExtensions } from './extensions';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';

const value: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-one',
  sourceDatabaseId: 'missing-source',
  title: 'Useful title',
  columnOrder: ['quantity'],
  filter: null,
};

const paragraph = (text: string): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

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

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('independent linked-view editor fallback', () => {
  it('keeps the atom editable and shows an inert readable fallback without a provider', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        paragraph('text before'),
        { type: 'polarisDadosView', attrs: value },
        paragraph('text after'),
      ],
    };
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
      content: doc as never,
    });

    const actual = editor.getJSON() as DocNode;
    expect(actual.content?.[1]).toEqual({ type: 'polarisDadosView', attrs: value });
    expect(actual.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'polarisDadosView',
      'paragraph',
    ]);
    expect(editor.view.dom.textContent).toContain('Linked view unavailable');
    expect(editor.view.dom.textContent).toContain(value.title);
    expect(editor.view.dom.textContent).toContain(value.sourceDatabaseId);
    expect(editor.view.dom.querySelector('[data-provider], [data-morrow-database-provider]')).toBeNull();
    expect(editor.view.dom.querySelector('button, input, select, table')).toBeNull();
    expect(docToPlainText(doc)).toContain(value.title);
    expect(docToPlainText(doc)).not.toContain('quantity');
  });

  it('consumes an invalid linked-view Markdown paste without inserting its raw fallback', () => {
    const target = make({ type: 'doc', content: [] });
    const before = target.getJSON();
    const markdown = '- # Heading\n\n  ' + encodePolarisDadosViewMarker(value) + '\n';
    const event = {
      clipboardData: {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? markdown : ''),
      },
    } as unknown as ClipboardEvent;
    let handled = false;

    target.view.someProp('handlePaste', (handler: NonNullable<EditorProps['handlePaste']>) => {
      handled = handler(target.view, event, new Slice(Fragment.empty, 0, 0)) === true;
      return handled;
    });

    expect(handled).toBe(true);
    expect(target.getJSON()).toEqual(before);
  });

  it('still opens a pre-existing protected rawBlock without interpreting its marker', () => {
    const source = encodePolarisDadosViewMarker(value);
    const protectedDoc: DocNode = {
      type: 'doc',
      content: [{ type: 'rawBlock', attrs: { text: '- # Heading\n\n  ' + source } }],
    };
    const target = make(protectedDoc);

    expect(target.getJSON()).toEqual(protectedDoc);
    expect(target.state.doc.firstChild?.type.name).toBe('rawBlock');
    expect(target.state.doc.childCount).toBe(1);
    expect((target.getJSON() as DocNode).content?.[0]?.attrs?.text).toContain(source);
  });
});
