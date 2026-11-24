// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import { t } from '../i18n';
import { BlockMenu, turnInto } from './EditorMenus';
import { createExtensions } from './extensions';

vi.mock('./bases', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onPagesChange: () => () => {},
}));

const inlineCode = String.fromCharCode(96);
const source = `<details>
<summary data-block-background="#1A2B3C" data-morrow-summary-format="markdown"><h2>Plan **bold** <u>underlined</u> ${inlineCode}code${inlineCode} [guide](https://example.org/guide) [[Other|internal]]</h2></summary>

Inside toggle.

</details>

Outside paragraph.
`;

const parse = () =>
  markdownToDoc(source, { resolvePage: (target: string) => (target === 'Other' ? 'other-page' : null) });
const serialize = (doc: DocNode) =>
  docToMarkdown(doc, { linkTarget: (id: string) => (id === 'other-page' ? 'Other' : null) });

let editor: Editor | null = null;
let host: HTMLElement | null = null;
let menuRoot: Root | null = null;
let menuHost: HTMLElement | null = null;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function make(content: DocNode): Editor {
  host = document.createElement('div');
  document.body.append(host);
  editor = new Editor({
    element: host,
    extensions: createExtensions({
      onBlockMenu: () => {},
      getTitle: (id: string) => (id === 'other-page' ? 'Other' : null),
      resolvePage: () => null,
      resolveTarget: () => null,
      subscribe: () => () => {},
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      findPages: () => [],
      createPage: () => null,
      createFromTarget: () => null,
      renderEmbed: () => {},
    } as never),
    content: content as never,
  });
  return editor;
}

function summaryPosition(target: Editor): number {
  let position = -1;
  target.state.doc.descendants((node, pos) => {
    if (node.type.name === 'detailsSummary') position = pos;
  });
  return position;
}

function pressKey(target: Editor, key: string): boolean | void | undefined {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  return target.view.someProp('handleKeyDown', (handler) => handler(target.view, event));
}

afterEach(async () => {
  if (menuRoot) await act(async () => menuRoot?.unmount());
  menuRoot = null;
  menuHost?.remove();
  menuHost = null;
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

describe('published colored toggle titles in the editor', () => {
  it('renders the HEX background, heading level, marks and links in the real editor DOM inside and outside columns', () => {
    const parsed = parse();
    const outside = make(parsed);
    const outsideSummary = outside.view.dom.querySelector<HTMLElement>('summary');
    expect(outsideSummary).not.toBeNull();
    expect(outsideSummary?.getAttribute('data-block-background')).toBe('#1a2b3c');
    expect(outsideSummary?.getAttribute('data-level')).toBe('2');
    expect(outsideSummary?.classList.contains('block-bg-custom')).toBe(true);
    expect(outsideSummary?.style.getPropertyValue('--block-bg')).toBe('#1a2b3c');
    expect(outsideSummary?.querySelector('strong')?.textContent).toBe('bold');
    expect(outsideSummary?.querySelector('u')?.textContent).toBe('underlined');
    expect(outsideSummary?.querySelector('code')?.textContent).toBe('code');
    expect(outsideSummary?.querySelector('a[href="https://example.org/guide"]')?.textContent).toBe('guide');
    expect(outsideSummary?.querySelector('.page-link')?.textContent).toBe('internal');
    outside.destroy();
    editor = null;
    host?.remove();
    host = null;

    const toggle = parsed.content?.[0];
    expect(toggle?.type).toBe('details');
    const inColumn: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            { type: 'column', content: [toggle!] },
            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Neighbor' }] }] },
          ],
        },
      ],
    };
    const inside = make(inColumn);
    const columnSummary = inside.view.dom.querySelector<HTMLElement>('summary');
    expect(columnSummary?.getAttribute('data-block-background')).toBe('#1a2b3c');
    expect(columnSummary?.classList.contains('block-bg-custom')).toBe(true);
    expect(columnSummary?.style.getPropertyValue('--block-bg')).toBe('#1a2b3c');
    expect(serialize(inside.getJSON() as DocNode)).toContain('data-block-background="#1a2b3c"');
  });

  it('keeps the colored title and rich inline content when unwrapped, including undo and redo', () => {
    const target = make(parse());
    const original = target.getJSON() as DocNode;
    const position = summaryPosition(target);
    expect(position).toBeGreaterThanOrEqual(0);
    target.commands.setTextSelection(position + 1);

    expect(target.commands.unsetDetails()).toBe(true);
    const unwrapped = target.getJSON() as DocNode;
    expect(unwrapped.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2, backgroundColor: '#1a2b3c' } });
    expect(unwrapped.content?.[0]?.content).toEqual(original.content?.[0]?.content?.[0]?.content);
    expect(unwrapped.content?.[1]?.content?.[0]?.text).toBe('Inside toggle.');
    expect(unwrapped.content?.[2]?.content?.[0]?.text).toBe('Outside paragraph.');
    expect(serialize(unwrapped)).toContain('<!-- morrow:block-background:#1a2b3c -->');
    expect(serialize(unwrapped)).toContain('[guide](https://example.org/guide)');

    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
    expect(target.commands.redo()).toBe(true);
    expect((target.getJSON() as DocNode).content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2, backgroundColor: '#1a2b3c' },
    });
  });

  it('edits title text and saves/reopens with the HEX, level, marks and links intact', () => {
    const target = make(parse());
    const original = target.getJSON();
    const position = summaryPosition(target);
    target.view.dispatch(target.state.tr.insertText('Edited ', position + 1));
    const edited = target.getJSON() as DocNode;
    const markdown = serialize(edited);
    expect(edited.content?.[0]?.content?.[0]).toMatchObject({
      type: 'detailsSummary',
      attrs: { level: 2, backgroundColor: '#1a2b3c' },
    });
    expect(markdown).toContain('<h2>Edited Plan');
    expect(markdown).toContain('<u>underlined</u>');
    expect(markdown).toContain('[guide](https://example.org/guide)');
    expect(markdown).toContain('[[Other|internal]]');

    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
    expect(target.commands.redo()).toBe(true);
    expect(target.getJSON()).toEqual(edited);

    const reopened = markdownToDoc(markdown, {
      resolvePage: (linked: string) => (linked === 'Other' ? 'other-page' : null),
    });
    expect(reopened.content?.[0]?.content?.[0]).toMatchObject({
      type: 'detailsSummary',
      attrs: { level: 2, backgroundColor: '#1a2b3c' },
    });
    target.destroy();
    editor = null;
    host?.remove();
    host = null;
    const reopenedEditor = make(reopened);
    const reopenedSummary = reopenedEditor.view.dom.querySelector<HTMLElement>('summary');
    expect(reopenedSummary?.getAttribute('data-block-background')).toBe('#1a2b3c');
    expect(reopenedSummary?.classList.contains('block-bg-custom')).toBe(true);
    expect(reopenedSummary?.querySelector('strong')?.textContent).toBe('bold');
    expect(reopenedSummary?.querySelector('.page-link')?.textContent).toBe('internal');
  });

  it('uses Backspace at the title start to preserve the heading and background when unwrapping', () => {
    const target = make(parse());
    const original = target.getJSON();
    const position = summaryPosition(target);
    target.commands.setTextSelection(position + 1);

    expect(pressKey(target, 'Backspace')).toBe(true);
    expect((target.getJSON() as DocNode).content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2, backgroundColor: '#1a2b3c' },
    });
    expect((target.getJSON() as DocNode).content?.[1]?.content?.[0]?.text).toBe('Inside toggle.');
    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
    expect(target.commands.redo()).toBe(true);
    expect((target.getJSON() as DocNode).content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2, backgroundColor: '#1a2b3c' },
    });
  });

  it('preserves the title background when changing its heading level and refuses an unsupported conversion', () => {
    const target = make(parse());
    const original = target.getJSON();
    turnInto(target, 0, { kind: 'callout' });
    expect(target.getJSON()).toEqual(original);

    turnInto(target, 0, { kind: 'toggle', level: 3 });
    expect((target.getJSON() as DocNode).content?.[0]?.content?.[0]).toMatchObject({
      type: 'detailsSummary',
      attrs: { level: 3, backgroundColor: '#1a2b3c' },
    });
  });

  it('converts a colored toggle to a heading and preserves undo/redo', () => {
    const target = make(parse());
    const original = target.getJSON();
    turnInto(target, 0, { kind: 'heading', level: 3 });
    const converted = target.getJSON() as DocNode;
    expect(converted.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 3, backgroundColor: '#1a2b3c' } });
    expect(converted.content?.[0]?.content).toEqual((original as DocNode).content?.[0]?.content?.[0]?.content);
    expect(serialize(converted)).toContain('<!-- morrow:block-background:#1a2b3c -->');
    expect(target.commands.undo()).toBe(true);
    expect(target.getJSON()).toEqual(original);
    expect(target.commands.redo()).toBe(true);
    expect((target.getJSON() as DocNode).content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 3, backgroundColor: '#1a2b3c' },
    });
  });

  it('uses the accessible toggle button to open and close content while restoring the editor selection and focus', () => {
    const target = make(parse());
    const position = summaryPosition(target);
    target.commands.setTextSelection(position + 2);
    target.commands.focus();
    const selection = target.state.selection.from;
    const button = target.view.dom.querySelector<HTMLButtonElement>('.toggle > button');
    const content = target.view.dom.querySelector<HTMLElement>('[data-type="detailsContent"]');
    expect(button?.type).toBe('button');
    expect(button?.getAttribute('aria-label')).toBe('Expand details content');
    expect(content?.hasAttribute('hidden')).toBe(true);

    button?.focus();
    button?.click();
    expect((target.getJSON() as DocNode).content?.[0]?.attrs?.open).toBe(true);
    expect(button?.getAttribute('aria-label')).toBe('Collapse details content');
    expect(content?.hasAttribute('hidden')).toBe(false);
    expect(target.state.selection.from).toBe(selection);
    expect(document.activeElement).toBe(button);

    button?.click();
    expect((target.getJSON() as DocNode).content?.[0]?.attrs?.open).toBe(false);
    expect(button?.getAttribute('aria-label')).toBe('Expand details content');
    expect(content?.hasAttribute('hidden')).toBe(true);
    expect(target.state.selection.from).toBe(selection);
    expect(document.activeElement).toBe(button);
  });

  it('returns keyboard focus to the editor when the mounted block menu rejects an unsupported callout conversion', async () => {
    const target = make(parse());
    const selection = summaryPosition(target) + 2;
    target.commands.setTextSelection(selection);
    target.commands.focus();
    const original = target.getJSON();

    menuHost = document.createElement('div');
    document.body.append(menuHost);
    menuRoot = createRoot(menuHost);
    await act(async () => {
      menuRoot?.render(
        createElement(BlockMenu, {
          editor: target,
          request: { pos: 0, rect: new DOMRect(0, 0, 0, 0) },
          pageTitle: 'Toggle editor test',
          onClose: () => menuRoot?.render(null),
        }),
      );
    });

    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    const callout = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) =>
      button.textContent?.includes(t('editor.callout')),
    );
    expect(menu).not.toBeNull();
    expect(callout).toBeDefined();

    // Exercise the mounted menu's keyboard navigation. Focus its first item because happy-dom
    // does not focus descendants while the floating menu is initially visibility:hidden.
    const firstItem = menu?.querySelector<HTMLButtonElement>('button');
    firstItem?.focus();
    expect(document.activeElement).toBe(firstItem);
    for (let step = 0; document.activeElement !== callout && step < 40; step++) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    }
    expect(document.activeElement).toBe(callout);
    // happy-dom does not synthesize a button's native click from Enter, so dispatch that default
    // activation after verifying the keyboard navigation arrived at the action.
    callout?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await act(async () => callout?.click());

    expect(target.getJSON()).toEqual(original);
    expect(target.state.selection.from).toBe(selection);
    expect(document.activeElement).toBe(target.view.dom);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});
