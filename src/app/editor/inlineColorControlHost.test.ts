// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import type { PluginInlineColorControlEntry } from '../plugins/registry';
import { createInlineColorControlHost } from './inlineColorControlHost';
import { createExtensions } from './extensions';

vi.mock('./bases', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onPagesChange: () => () => {},
}));

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
      findPages: () => [],
      createPage: () => null,
      renderEmbed: () => {},
    } as never),
    content: content as never,
  });
  return editor;
}

function registration(): PluginInlineColorControlEntry {
  return { owner: 'polaris-documento', mount: () => {}, isActive: () => true };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('Documento inline color control host', () => {
  it('applies exact custom colors to the selected text in H1–H6 without changing heading nodes or other marks', () => {
    const target = make({
      type: 'doc',
      content: [1, 2, 3, 4, 5, 6].map((level) => ({
        type: 'heading',
        attrs: { level },
        content: [
          {
            type: 'text',
            text: `Heading ${level}`,
            marks: [{ type: 'highlight', attrs: { color: 'yellow' } }],
          },
        ],
      })),
    });
    const session = { active: true };
    const headings: Array<{ position: number; level: number }> = [];
    target.state.doc.descendants((node, position) => {
      if (node.type.name === 'heading') headings.push({ position, level: node.attrs.level as number });
    });

    for (const heading of headings) {
      target.commands.setTextSelection({ from: heading.position + 1, to: heading.position + 8 });
      const mounted = createInlineColorControlHost({
        editor: target,
        kind: 'text',
        registration: registration(),
        label: 'Custom text colour',
        inputLabel: 'HEX colour for text',
        invalidMessage: 'Enter a valid six-digit HEX colour.',
        isSessionActive: () => session.active,
        onFinish: () => {},
      });
      expect(mounted).not.toBeNull();
      expect(mounted!.host.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(mounted!.host.apply('#12AB34')).toBe(true);
      mounted!.dispose();
    }

    const document = target.getJSON() as DocNode;
    expect(document.content?.map((node) => node.attrs?.level)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const node of document.content ?? []) {
      expect(node.type).toBe('heading');
      const content = node.content ?? [];
      expect(content[0]?.text).toBe('Heading');
      expect(content[0]?.marks).toEqual([
        { type: 'highlight', attrs: { color: 'yellow' } },
        { type: 'textColor', attrs: { color: '#12ab34' } },
      ]);
      expect(content[1]?.text).toMatch(/^ [1-6]$/);
      expect(content[1]?.marks).toEqual([{ type: 'highlight', attrs: { color: 'yellow' } }]);
    }
    const renderedHeadings = target.view.dom.querySelectorAll('h1, h2, h3, h4, h5, h6');
    expect(renderedHeadings).toHaveLength(6);
    for (const heading of renderedHeadings) {
      expect(heading.getAttribute('style')).toBeNull();
      expect(heading.querySelector('span[data-color]')?.getAttribute('style')).toBe('color: #12ab34;');
    }
  });

  it('applies a custom highlight to only the selected text and preserves an overlapping text color', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'selected text',
              marks: [{ type: 'textColor', attrs: { color: 'red' } }],
            },
          ],
        },
      ],
    });
    target.commands.setTextSelection({ from: 1, to: 9 });
    const mounted = createInlineColorControlHost({
      editor: target,
      kind: 'bg',
      registration: registration(),
      label: 'Custom highlight colour',
      inputLabel: 'HEX colour for highlight',
      invalidMessage: 'Enter a valid six-digit HEX colour.',
      isSessionActive: () => true,
      onFinish: () => {},
    });
    expect(mounted!.host.color).toBe('#fbf3db');
    expect(mounted!.host.apply('#ABCDEF')).toBe(true);
    mounted!.dispose();

    const text = (target.getJSON() as DocNode).content?.[0]?.content ?? [];
    expect(text[0]?.text).toBe('selected');
    expect(text[0]?.marks).toEqual([
      { type: 'highlight', attrs: { color: '#abcdef' } },
      { type: 'textColor', attrs: { color: 'red' } },
    ]);
    expect(text[1]?.text).toBe(' text');
    expect(text[1]?.marks).toEqual([{ type: 'textColor', attrs: { color: 'red' } }]);
  });

  it('rejects invalid HEX, stale selection, readonly state, inactive owner, and closed session', () => {
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'selected text' }] }],
    });
    target.commands.setTextSelection({ from: 1, to: 9 });
    let active = true;
    let sessionActive = true;
    const owner = registration();
    const mounted = createInlineColorControlHost({
      editor: target,
      kind: 'text',
      registration: { ...owner, isActive: () => active },
      label: 'Custom text colour',
      inputLabel: 'HEX colour for text',
      invalidMessage: 'Enter a valid six-digit HEX colour.',
      isSessionActive: () => sessionActive,
      onFinish: () => {},
    });
    expect(mounted).not.toBeNull();
    const before = target.getJSON();
    for (const invalid of ['#12345', '#12345678', 'rgb(1, 2, 3)', 'url(javascript:alert(1))'])
      expect(mounted!.host.apply(invalid)).toBe(false);
    expect(target.getJSON()).toEqual(before);

    target.commands.setTextSelection({ from: 2, to: 10 });
    expect(mounted!.host.apply('#123456')).toBe(false);
    target.commands.setTextSelection({ from: 1, to: 9 });

    sessionActive = false;
    expect(mounted!.host.apply('#123456')).toBe(false);
    sessionActive = true;
    active = false;
    expect(mounted!.host.apply('#123456')).toBe(false);
    active = true;
    target.setEditable(false);
    expect(mounted!.host.apply('#123456')).toBe(false);
    target.setEditable(true);
    mounted!.dispose();
    expect(mounted!.host.apply('#123456')).toBe(false);
    expect(target.getJSON()).toEqual(before);
  });

  it('permanently invalidates a mount after A→B→A selection or same-text document replacement', () => {
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'selected text' }] }],
    });
    target.commands.setTextSelection({ from: 1, to: 9 });
    const mount = (onFinish = () => {}) =>
      createInlineColorControlHost({
        editor: target,
        kind: 'text',
        registration: registration(),
        label: 'Custom text colour',
        inputLabel: 'HEX colour for text',
        invalidMessage: 'Enter a valid six-digit HEX colour.',
        isSessionActive: () => true,
        onFinish,
      })!;

    const focus = vi.spyOn(target.view, 'focus');
    const staleFinish = vi.fn();
    const movedAwayAndBack = mount(staleFinish);
    target.commands.setTextSelection({ from: 2, to: 10 });
    target.commands.setTextSelection({ from: 1, to: 9 });
    expect(movedAwayAndBack.host.apply('#123456')).toBe(false);
    movedAwayAndBack.host.finish();
    expect(focus).not.toHaveBeenCalled();
    expect(staleFinish).not.toHaveBeenCalled();
    expect(
      (target.getJSON() as DocNode).content?.[0]?.content?.flatMap((node) => node.marks ?? []),
    ).toEqual([]);
    movedAwayAndBack.dispose();

    const replacedFinish = vi.fn();
    const sameTextReplacement = mount(replacedFinish);
    target.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'selected text' }],
        },
      ],
    });
    target.commands.setTextSelection({ from: 1, to: 9 });
    expect(target.state.doc.textBetween(1, 9)).toBe('selected');
    expect(sameTextReplacement.host.apply('#abcdef')).toBe(false);
    sameTextReplacement.host.finish();
    expect(focus).not.toHaveBeenCalled();
    expect(replacedFinish).not.toHaveBeenCalled();
    expect((target.getJSON() as DocNode).content?.[0]?.type).toBe('heading');
    expect((target.getJSON() as DocNode).content?.[0]?.content?.[0]?.marks).toBeUndefined();
    sameTextReplacement.dispose();
  });

  it('returns focus, supports reset and keeps custom color in undo history', () => {
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'selected text' }] }],
    });
    target.commands.setTextSelection({ from: 1, to: 9 });
    const finish = vi.fn();
    const mounted = createInlineColorControlHost({
      editor: target,
      kind: 'text',
      registration: registration(),
      label: 'Custom text colour',
      inputLabel: 'HEX colour for text',
      invalidMessage: 'Enter a valid six-digit HEX colour.',
      isSessionActive: () => true,
      onFinish: finish,
    });
    expect(mounted!.host.apply('#654321')).toBe(true);
    expect(mounted!.host.apply('#abcdef')).toBe(false);
    mounted!.host.finish();
    expect(finish).toHaveBeenCalledOnce();
    expect((target.getJSON() as DocNode).content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'textColor', attrs: { color: '#654321' } },
    ]);

    target.commands.setTextColor(null);
    expect((target.getJSON() as DocNode).content?.[0]?.content?.[0]?.marks).toBeUndefined();
    target.commands.undo();
    expect((target.getJSON() as DocNode).content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'textColor', attrs: { color: '#654321' } },
    ]);
    mounted!.dispose();
  });
});
