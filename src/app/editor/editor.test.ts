// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorContent } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { selectBlockRange } from './BlockSelect';
import {
  changeCase,
  handleColorPanelKeyDown,
  setBlockBackground,
  setHeading,
  turnBlocks,
  turnInto,
} from './EditorMenus';
import { createExtensions } from './extensions';
import { tagDecorations } from './Extras';
import {
  BLOCK_ITEMS,
  getLocalizedBlocks,
  getSlashCommandItems,
  runSlashCommandItem,
} from './SlashCommand';
import type { DecorationSet } from '@tiptap/pm/view';

// code blocks watch the vault's pages for bases, there is no vault open here
vi.mock('./bases', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  onPagesChange: () => () => {},
}));

const json = (target: Editor) => target.getJSON() as DocNode;

let editor: Editor | null = null;

function make(content: unknown): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      resolveTarget: () => null,
      subscribe: () => () => {},
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

// types text at the cursor the way a keyboard does, so input rules run
function type(target: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = target.state.selection;
    const handled = target.view.someProp('handleTextInput', (handler) =>
      handler(target.view, from, to, char, () => target.state.tr.insertText(char, from, to)),
    );
    if (!handled) target.view.dispatch(target.state.tr.insertText(char, from, to));
  }
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const p = (text: string) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] });

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function textRange(target: Editor, text: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  target.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      range = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  if (!range) throw new Error(`Could not find text: ${text}`);
  return range;
}

describe('the editor', () => {
  it('offers six and seven columns only for a current editable root slash paragraph', async () => {
    const opened: Editor[] = [];
    const unmounts: Array<() => void> = [];
    const create = (content: unknown) => {
      const target = make(content);
      opened.push(target);
      return target;
    };
    const mount = (target: Editor) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      act(() => root.render(createElement(EditorContent, { editor: target })));
      unmounts.push(() => {
        act(() => root.unmount());
        container.remove();
      });
    };
    const slashOptions = { createChild: () => null };

    try {
      const canceled = create({ type: 'doc', content: [p('')] });
      mount(canceled);
      await act(async () => {
        canceled.view.focus();
        canceled.commands.setTextSelection(1);
        type(canceled, '/layout');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const canceledRange = textRange(canceled, '/layout');
      const offered = getSlashCommandItems('layout', canceled, canceledRange).map((item) => item.id);
      expect(offered).toContain('columns6');
      expect(offered).toContain('columns7');
      const canceledButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.suggestion-menu button'));
      const sixTitle = getLocalizedBlocks().find((item) => item.id === 'columns6')?.title;
      const sevenTitle = getLocalizedBlocks().find((item) => item.id === 'columns7')?.title;
      expect(canceledButtons.some((button) => button.textContent?.includes(sixTitle ?? '6 columns'))).toBe(true);
      expect(canceledButtons.some((button) => button.textContent?.includes(sevenTitle ?? '7 columns'))).toBe(true);
      const canceledBefore = json(canceled);
      act(() => {
        canceled.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });
      expect(json(canceled)).toEqual(canceledBefore);
      expect(document.querySelector('.suggestion-menu[role="listbox"]')).toBeNull();

      const staleClick = create({ type: 'doc', content: [p('')] });
      mount(staleClick);
      await act(async () => {
        staleClick.view.focus();
        staleClick.commands.setTextSelection(1);
        type(staleClick, '/layout');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const staleSevenTitle = getLocalizedBlocks().find((item) => item.id === 'columns7')?.title;
      const staleSevenButton = Array.from(
        document.querySelectorAll<HTMLButtonElement>('.suggestion-menu button'),
      ).find((button) => button.textContent?.includes(staleSevenTitle ?? '7 columns'));
      if (!staleSevenButton) throw new Error('The seven-column command is not in the slash menu.');
      const staleClickRange = textRange(staleClick, '/layout');
      act(() => {
        staleClick.view.dispatch(
          staleClick.state.tr.insertText('/canvas', staleClickRange.from, staleClickRange.to),
        );
        // Click the old row before React commits the updated suggestion list.
        expect(document.body.contains(staleSevenButton)).toBe(true);
        staleSevenButton.click();
      });
      expect(json(staleClick).content?.[0]?.content?.[0]?.text).toBe('/canvas');
      expect(json(staleClick).content?.[0]?.type).toBe('paragraph');
      act(() => {
        staleClick.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });

      const attributed = create({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { blockId: 'slash-layout', backgroundColor: '#2f80ed', embedTitle: false },
            content: [],
          },
        ],
      });
      mount(attributed);
      await act(async () => {
        attributed.view.focus();
        attributed.commands.setTextSelection(1);
        type(attributed, '/layout');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const attributedRange = textRange(attributed, '/layout');
      const attributedItems = getSlashCommandItems('layout', attributed, attributedRange).map(
        (item) => item.id,
      );
      expect(attributedItems).toContain('columns2');
      expect(attributedItems).toContain('columns5');
      expect(attributedItems).not.toContain('columns6');
      expect(attributedItems).not.toContain('columns7');
      const attributedBefore = json(attributed);
      runSlashCommandItem(attributed, attributedRange, 'columns7', slashOptions);
      expect(json(attributed)).toEqual(attributedBefore);
      act(() => {
        attributed.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      });

      const selected = create({ type: 'doc', content: [p('')] });
      mount(selected);
      await act(async () => {
        selected.view.focus();
        selected.commands.setTextSelection(1);
        type(selected, '/layout');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      const slashDoc = json(selected);
      const selectedSevenTitle = getLocalizedBlocks().find((item) => item.id === 'columns7')?.title;
      if (!selectedSevenTitle) throw new Error('The seven-column command is missing.');
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.suggestion-menu button'));
      const sevenIndex = buttons.findIndex((button) => button.textContent?.includes(selectedSevenTitle));
      if (sevenIndex < 0) throw new Error('The seven-column command is not in the slash menu.');
      for (let index = 0; index < sevenIndex; index++) {
        act(() => {
          selected.view.dom.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
          );
        });
      }
      act(() => {
        selected.view.dom.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      });
      expect(json(selected).content?.[0]?.type).toBe('columns');
      expect(json(selected).content?.[0]?.content).toHaveLength(7);
      expect(document.querySelector('.suggestion-menu[role="listbox"]')).toBeNull();
      const createdDoc = json(selected);
      expect(selected.commands.undo()).toBe(true);
      expect(json(selected)).toEqual(slashDoc);
      expect(selected.commands.redo()).toBe(true);
      expect(json(selected)).toEqual(createdDoc);
      expect(selected.state.selection.$from.node(1).childCount).toBe(7);

      const nested = create({
        type: 'doc',
        content: [
          {
            type: 'columns',
            content: [
              { type: 'column', content: [p('/layout')] },
              { type: 'column', content: [p('Neighbor')] },
            ],
          },
        ],
      });
      const nestedRange = textRange(nested, '/layout');
      nested.commands.setTextSelection(nestedRange.to);
      const nestedBefore = json(nested);
      expect(getSlashCommandItems('layout', nested, nestedRange).map((item) => item.id)).not.toContain('columns6');
      runSlashCommandItem(nested, nestedRange, 'columns6', slashOptions);
      expect(json(nested)).toEqual(nestedBefore);

      const readOnly = create({ type: 'doc', content: [p('/layout')] });
      const readOnlyRange = textRange(readOnly, '/layout');
      readOnly.commands.setTextSelection(readOnlyRange.to);
      readOnly.setEditable(false);
      const readOnlyBefore = json(readOnly);
      expect(getSlashCommandItems('layout', readOnly, readOnlyRange).map((item) => item.id)).not.toContain('columns7');
      runSlashCommandItem(readOnly, readOnlyRange, 'columns7', slashOptions);
      expect(json(readOnly)).toEqual(readOnlyBefore);

      const stale = create({ type: 'doc', content: [p('/layout')] });
      const staleRange = textRange(stale, '/layout');
      stale.commands.setTextSelection(staleRange.from + 1);
      const staleBefore = json(stale);
      expect(getSlashCommandItems('layout', stale, staleRange).map((item) => item.id)).not.toContain('columns6');
      runSlashCommandItem(stale, staleRange, 'columns6', slashOptions);
      expect(json(stale)).toEqual(staleBefore);
    } finally {
      for (const unmount of unmounts.reverse()) unmount();
      for (const target of opened) target.destroy();
      document.body.replaceChildren();
      editor = null;
    }
  });

  it('turns a line into a toggle titled with it when > is typed in front of it', () => {
    const target = make({ type: 'doc', content: [p('Shopping list')] });
    target.commands.setTextSelection(1);
    type(target, '> ');
    const toggle = json(target).content![0]!;
    expect(toggle.type).toBe('details');
    expect(toggle.content![0]!.type).toBe('detailsSummary');
    expect(toggle.content![0]!.content![0]!.text).toBe('Shopping list');
    const body = toggle.content![1]!.content!;
    expect(body).toHaveLength(1);
    expect(body[0]!.type).toBe('paragraph');
    expect(body[0]!.content ?? []).toEqual([]);
  });

  it('keeps a heading level when it becomes a toggle', () => {
    const target = make({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plans' }] }],
    });
    target.commands.setTextSelection(1);
    type(target, '> ');
    const summary = json(target).content![0]!.content![0]!;
    expect(summary.attrs?.level).toBe(2);
    expect(summary.content![0]!.text).toBe('Plans');
  });

  it('keeps supported legacy toggle summary links and HEX backgrounds in the editor schema', () => {
    const imported = markdownToDoc(
      '<details open>\n<summary data-block-background="#123abc" data-morrow-summary-format="markdown"><h2>Plan [[Other|internal]]</h2></summary>\n\nBody\n\n</details>',
    );
    const target = make(imported);
    const summary = json(target).content?.[0]?.content?.[0];
    expect(summary?.attrs?.backgroundColor).toBe('#123abc');
    expect(summary?.content?.[1]?.type).toBe('pageLink');
    expect(docToMarkdown(json(target))).toContain('data-block-background="#123abc"');
  });

  it('returns editor focus when Escape closes the inline color panel', async () => {
    const target = make({ type: 'doc', content: [p('Selected text')] });
    const focus = vi.spyOn(target.view, 'focus');
    const preventDefault = vi.fn();
    const onDone = vi.fn();
    handleColorPanelKeyDown(target, { key: 'Escape', preventDefault }, onDone);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(focus).toHaveBeenCalledOnce();
    handleColorPanelKeyDown(target, { key: 'Enter', preventDefault }, onDone);
    expect(focus).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();

    const staleDone = vi.fn();
    handleColorPanelKeyDown(target, { key: 'Escape', preventDefault }, staleDone, () => false);
    expect(focus).toHaveBeenCalledOnce();
    expect(staleDone).toHaveBeenCalledOnce();
  });

  it('makes a toggle title a heading with #', () => {
    const target = make({ type: 'doc', content: [p('Notes')] });
    target.commands.setTextSelection(1);
    type(target, '> ');
    type(target, '### ');
    const summary = json(target).content![0]!.content![0]!;
    expect(summary.attrs?.level).toBe(3);
    expect(summary.content![0]!.text).toBe('Notes');
  });

  it('keeps no empty line at the end of a page', () => {
    const target = make({ type: 'doc', content: [p('One'), { type: 'horizontalRule' }] });
    expect(json(target).content!.map((node) => node.type)).toEqual(['paragraph', 'horizontalRule']);
  });

  it('renders inline custom colors as validated CSS while keeping palette marks unchanged', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            {
              type: 'text',
              text: 'Both',
              marks: [
                { type: 'highlight', attrs: { color: '#abcdef' } },
                { type: 'textColor', attrs: { color: '#12ab34' } },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Preset',
              marks: [
                { type: 'highlight', attrs: { color: 'blue' } },
                { type: 'textColor', attrs: { color: 'red' } },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Invalid',
              marks: [{ type: 'textColor', attrs: { color: '#1234' } }],
            },
          ],
        },
      ],
    });

    const customHeading = target.view.dom.querySelector('h2 mark[style] span[style]');
    expect(customHeading?.getAttribute('style')).toBe('color: #12ab34;');
    expect(customHeading?.parentElement?.getAttribute('style')).toBe('background-color: #abcdef;');
    expect(customHeading?.getAttribute('data-color')).toBe('#12ab34');
    expect(customHeading?.parentElement?.getAttribute('data-color')).toBe('#abcdef');

    const preset = target.view.dom.querySelector('.text-red');
    expect(preset?.getAttribute('data-color')).toBe('red');
    expect(preset?.getAttribute('style')).toBeNull();
    expect(preset?.parentElement?.getAttribute('data-color')).toBe('blue');
    expect(preset?.parentElement?.classList.contains('bg-blue')).toBe(true);

    const invalid = target.view.dom.querySelector('p:last-child span');
    expect(invalid?.getAttribute('style')).toBeNull();
    expect(invalid?.getAttribute('data-color')).toBeNull();
  });

  it('parses only supported inline color shapes from HTML', () => {
    const target = make(
      '<p><span data-color="#12AB34" style="color: #12ab34">custom</span> <mark data-color="#ABCDEF" style="background-color: #abcdef">marker</mark> <span style="color: #fedcba">standalone</span> <span style="color: red">preset</span></p>' as never,
    );
    const content = json(target).content![0]!.content!;
    const text = (value: string) => content.find((node) => node.text === value);
    expect(text('custom')?.marks).toEqual([{ type: 'textColor', attrs: { color: '#12ab34' } }]);
    expect(text('marker')?.marks).toEqual([{ type: 'highlight', attrs: { color: '#abcdef' } }]);
    expect(text('standalone')?.marks).toEqual([{ type: 'textColor', attrs: { color: '#fedcba' } }]);
    expect(text('preset')?.marks).toEqual([{ type: 'textColor', attrs: { color: 'red' } }]);

    const pasted = make({ type: 'doc', content: [p('')] });
    pasted.commands.setTextSelection(1);
    expect(
      pasted.commands.insertContent(
        '<span data-color="#123456" style="color: #123456">pasted text</span><mark data-color="#abcdef" style="background-color: #abcdef">pasted highlight</mark>',
      ),
    ).toBe(true);
    const pastedNodes = json(pasted).content![0]!.content!;
    expect(pastedNodes.find((node) => node.text === 'pasted text')?.marks).toEqual([
      { type: 'textColor', attrs: { color: '#123456' } },
    ]);
    expect(pastedNodes.find((node) => node.text === 'pasted highlight')?.marks).toEqual([
      { type: 'highlight', attrs: { color: '#abcdef' } },
    ]);

    const cssomPaste = make({ type: 'doc', content: [p('')] });
    cssomPaste.commands.setTextSelection(1);
    expect(
      cssomPaste.commands.insertContent(
        '<span data-color="#12ab34" style="color: rgb(18, 171, 52);">CSSOM text</span><mark data-color="#abcdef" style="background-color: rgb(171, 205, 239);">CSSOM highlight</mark>',
      ),
    ).toBe(true);
    const cssomNodes = json(cssomPaste).content![0]!.content!;
    expect(cssomNodes.find((node) => node.text === 'CSSOM text')?.marks).toEqual([
      { type: 'textColor', attrs: { color: '#12ab34' } },
    ]);
    expect(cssomNodes.find((node) => node.text === 'CSSOM highlight')?.marks).toEqual([
      { type: 'highlight', attrs: { color: '#abcdef' } },
    ]);

    const unsafe = make(
      '<p><span style="color: #123456; background: url(javascript:alert(1))">extra CSS</span><mark style="background: #1234">malformed</mark><span data-color="#123456" style="color: #123457">mismatch</span><span data-color="#123456" style="color: rgb(18, 52, 87)">rgb mismatch</span><span data-color="#123456" style="color: rgb(18, 52, 256)">rgb out of range</span><span data-color="#123456" style="color: rgba(18, 52, 86, 1)">rgb alpha</span><span data-color="#123456" style="color: rgb(18, 52, 86); opacity: 0.5">rgb extra CSS</span><span data-color="#123456" style="background-color: #123456">wrong property</span><mark data-color="#abcdef" style="background-color: #abcdef; color: red">multi</mark><mark data-color="red" style="background-color: #abcdef">palette pair</mark><span data-color="#abcdef">unpaired custom</span></p>' as never,
    );
    expect(
      json(unsafe)
        .content![0]!.content!.flatMap((node) => node.marks ?? [])
        .some((mark) => mark.type === 'textColor' || mark.type === 'highlight'),
    ).toBe(false);
  });

  it('changes the case of words in a table cell', () => {
    const cell = (type: string, text: string) => ({ type, content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'Name'), cell('tableHeader', 'Note')] },
            { type: 'tableRow', content: [cell('tableCell', 'ada'), cell('tableCell', 'quiet')] },
          ],
        },
      ],
    });
    let start = 0;
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'quiet') start = pos;
    });
    target.commands.setTextSelection({ from: start, to: start + 5 });
    changeCase(target, (text) => text.toUpperCase());
    expect(target.getText()).toContain('QUIET');
    // dragging across cells picks whole cells
    const cells: number[] = [];
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') cells.push(pos);
    });
    target.view.dispatch(
      target.state.tr.setSelection(CellSelection.create(target.state.doc, cells[0]!, cells[1]!)),
    );
    changeCase(target, (text) => text.toLowerCase());
    expect(target.getText()).toContain('quiet');
    expect(target.getText()).toContain('ada');
  });

  it('changes the case of every cell picked, not only the first', () => {
    const cell = (text: string) => ({ type: 'tableCell', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('one'), cell('two')] },
            { type: 'tableRow', content: [cell('three'), cell('four')] },
          ],
        },
      ],
    });
    const cells: number[] = [];
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') cells.push(pos);
    });
    target.view.dispatch(
      target.state.tr.setSelection(CellSelection.create(target.state.doc, cells[0]!, cells[3]!)),
    );
    changeCase(target, (text) => text.toUpperCase());
    expect(target.getText()).toMatch(/ONE.*TWO.*THREE.*FOUR/s);
  });

  it('makes a toggle heading from the toolbar inside a toggle title', () => {
    const target = make({ type: 'doc', content: [p('Plans')] });
    target.commands.setTextSelection(1);
    type(target, '> ');
    target.commands.setTextSelection({ from: 2, to: 7 });
    setHeading(target, 2);
    expect(json(target).content![0]!.content![0]!.attrs?.level).toBe(2);
    setHeading(target, 2);
    expect(json(target).content![0]!.content![0]!.attrs?.level ?? null).toBeNull();
  });

  it('copies pictures with the words when blocks are picked in the margin', () => {
    const target = make({
      type: 'doc',
      content: [p('Before'), { type: 'image', attrs: { src: 'https://example.org/cat.png', alt: 'cat' } }],
    });
    selectBlockRange(target.view, { from: 0, to: target.state.doc.content.size });
    const data = new DataTransfer();
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true });
    target.view.dom.dispatchEvent(event);
    expect(data.getData('text/plain')).toContain('Before');
    expect(data.getData('text/html')).toContain('cat.png');
  });

  it('keeps tag chips right while typing, updating only what changed', () => {
    const target = make({ type: 'doc', content: [p('Plan #garden and #home'), p('nothing'), p('#a #b')] });
    const shown = (set: DecorationSet) =>
      set
        .find()
        .map((item) => `${item.from}-${item.to}`)
        .sort()
        .join(' ');
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let step = 0; step < 400; step++) {
      const size = target.state.doc.content.size;
      const at = 1 + random(Math.max(1, size - 1));
      const action = random(6);
      target.commands.setTextSelection(Math.min(at, size - 1));
      if (action < 3) type(target, ['#', 'a', ' ', 'x', '#t'][random(5)]!);
      else if (action === 3)
        target.commands.deleteRange({ from: Math.max(1, at - 2), to: Math.min(at, size - 1) });
      else if (action === 4) target.commands.splitBlock();
      else target.commands.joinBackward();
      const plugin = target.state.plugins.find((item) =>
        (item as unknown as { key: string }).key.startsWith('tags'),
      );
      const live = (plugin ?? { getState: () => null }).getState(target.state) as DecorationSet | null;
      expect(live && shown(live)).toBe(shown(tagDecorations(target.state.doc)));
    }
  });
});

describe('turn into', () => {
  it('puts a line in the first of several columns', () => {
    const target = make({ type: 'doc', content: [p('Left'), p('After')] });
    turnInto(target, 0, { kind: 'columns', count: 4 });
    const columns = json(target).content![0]!;
    expect(columns.type).toBe('columns');
    expect(columns.content).toHaveLength(4);
    expect(columns.content![0]!.content![0]!.content![0]!.text).toBe('Left');
    expect(json(target).content![1]!.content![0]!.text).toBe('After');
  });

  it('makes a lettered list and a callout', () => {
    const target = make({ type: 'doc', content: [p('First'), p('Second')] });
    turnInto(target, 0, { kind: 'letteredList' });
    const list = json(target).content![0]!;
    expect(list.type).toBe('orderedList');
    expect(list.attrs?.type).toBe('a');
    const second = target.state.doc.child(0).nodeSize;
    turnInto(target, second, { kind: 'callout' });
    expect(json(target).content![1]!.type).toBe('callout');
  });

  it('keeps a colored paragraph background when turned into a heading and preserves cursor and undo', () => {
    const backgroundColor = '#2f80ed';
    const target = make({
      type: 'doc',
      content: [{ ...p('Shaded line'), attrs: { backgroundColor } }],
    });
    turnInto(target, 0, { kind: 'heading', level: 2 });
    const heading = json(target).content![0]!;
    expect(heading).toMatchObject({ type: 'heading', attrs: { level: 2, backgroundColor } });
    expect(target.state.selection.$from.parent.type.name).toBe('heading');
    const serialized = docToMarkdown(json(target));
    expect(serialized).toContain('<!-- morrow:block-background:#2f80ed -->');
    expect(markdownToDoc(serialized)).toEqual(json(target));

    expect(target.commands.undo()).toBe(true);
    expect(json(target).content![0]).toMatchObject({ type: 'paragraph', attrs: { backgroundColor } });
  });

  it('keeps a colored paragraph background on a blockquote owner', () => {
    const backgroundColor = '#2f80ed';
    const target = make({
      type: 'doc',
      content: [{ ...p('Quoted line'), attrs: { backgroundColor } }],
    });
    turnInto(target, 0, { kind: 'blockquote' });
    const quote = json(target).content![0]!;
    expect(quote).toMatchObject({ type: 'blockquote', attrs: { backgroundColor } });
    expect(target.state.selection.$from.parent.type.name).toBe('paragraph');
    const serialized = docToMarkdown(json(target));
    expect(serialized).toContain('<!-- morrow:block-background:#2f80ed -->');
    expect(markdownToDoc(serialized)).toMatchObject({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { backgroundColor },
          content: [{ type: 'paragraph', content: [{ text: 'Quoted line' }] }],
        },
      ],
    });
  });

  it('keeps list conversions when representable and blocks unsupported toggle/callout conversions', () => {
    for (const targetKind of ['toggle', 'callout'] as const) {
      const target = make({
        type: 'doc',
        content: [{ ...p('Shaded line'), attrs: { backgroundColor: '#2f80ed' } }],
      });
      turnInto(target, 0, targetKind === 'toggle' ? { kind: targetKind, level: 2 } : { kind: targetKind });
      expect(json(target).content![0]).toMatchObject({
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
      });
      editor?.destroy();
      editor = null;
    }

    const list = make({
      type: 'doc',
      content: [{ ...p('Shaded line'), attrs: { backgroundColor: '#2f80ed' } }],
    });
    turnInto(list, 0, { kind: 'bulletList' });
    expect(json(list).content![0]!.type).toBe('bulletList');
    expect(json(list).content![0]!.content![0]!.content![0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: '#2f80ed' },
    });
    expect(docToMarkdown(markdownToDoc(docToMarkdown(json(list))))).toEqual(docToMarkdown(json(list)));
    list.destroy();
    editor = null;

    const native = make({
      type: 'doc',
      content: [{ ...p('Native palette'), attrs: { backgroundColor: 'green' } }],
    });
    turnInto(native, 0, { kind: 'bulletList' });
    expect(json(native).content![0]!.type).toBe('bulletList');
  });

  it('preserves list paragraph and native item colors through safe menu conversions', () => {
    const color = '#2f80ed';
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ ...p('Colored item line'), attrs: { backgroundColor: color } }],
            },
          ],
        },
      ],
    });
    turnInto(target, 1, { kind: 'heading', level: 2 });
    expect(json(target).content![0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2, backgroundColor: color },
    });
    expect(docToMarkdown(markdownToDoc(docToMarkdown(json(target))))).toEqual(docToMarkdown(json(target)));
    expect(target.commands.undo()).toBe(true);
    expect(json(target).content![0]!.content![0]!.content![0]!).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: color },
    });
    target.destroy();
    editor = null;

    const task = make({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true, backgroundColor: 'yellow' },
              content: [p('Native item color')],
            },
          ],
        },
      ],
    });
    turnInto(task, 1, { kind: 'bulletList' });
    expect(json(task).content![0]!.content![0]).toMatchObject({
      type: 'listItem',
      attrs: { backgroundColor: 'yellow' },
    });
    expect(docToMarkdown(markdownToDoc(docToMarkdown(json(task))))).toEqual(docToMarkdown(json(task)));
    task.destroy();
    editor = null;

    const refused = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ ...p('Task first line'), attrs: { backgroundColor: color } }],
            },
          ],
        },
      ],
    });
    const before = json(refused);
    const selection = refused.state.selection;
    turnInto(refused, 1, { kind: 'taskList' });
    expect(json(refused)).toEqual(before);
    expect(refused.state.selection).toEqual(selection);
    expect(() => docToMarkdown(json(refused))).not.toThrow();
  });

  it('keeps an empty colored list paragraph beside the native item palette when its text is deleted', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [{ ...p('First'), attrs: { backgroundColor: '#2f80ed' } }],
            },
          ],
        },
      ],
    });
    let textPos = -1;
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'First') textPos = pos;
    });
    expect(textPos).toBeGreaterThan(0);

    target.view.dispatch(target.state.tr.delete(textPos, textPos + 'First'.length));

    expect(json(target).content![0]!.content![0]).toMatchObject({
      type: 'listItem',
      attrs: { backgroundColor: 'yellow' },
      content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
    });
    expect(json(target).content![0]!.content![0]!.content![0]!.content ?? []).toEqual([]);
    const saved = docToMarkdown(json(target));
    expect(saved).toContain('<!-- morrow:block-background:#2f80ed -->');
    expect(saved).toContain('<br> <!-- background: yellow -->');
    expect(docToMarkdown(markdownToDoc(saved))).toBe(saved);
    expect(target.commands.undo()).toBe(true);
    expect(docToMarkdown(json(target))).toContain('First');
    let paragraphPos = -1;
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'First') paragraphPos = pos;
    });
    expect(paragraphPos).toBeGreaterThan(0);
    setBlockBackground(target, [paragraphPos], null);
    expect(json(target).content![0]!.content![0]!.content![0]!.attrs?.backgroundColor ?? null).toBeNull();
    const withoutParagraphColor = docToMarkdown(json(target));
    expect(withoutParagraphColor).not.toContain('morrow:block-background');
    expect(withoutParagraphColor).toContain('<!-- background: yellow -->');
    expect(docToMarkdown(markdownToDoc(withoutParagraphColor))).toBe(withoutParagraphColor);
  });

  it('refuses to convert a named-colored first paragraph into an ambiguous task title', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [{ ...p('First'), attrs: { backgroundColor: 'green' } }],
            },
          ],
        },
      ],
    });
    const before = json(target);
    const selection = target.state.selection;
    expect(() => docToMarkdown(before)).not.toThrow();

    turnInto(target, 1, { kind: 'taskList' });

    expect(json(target)).toEqual(before);
    expect(target.state.selection).toEqual(selection);
    expect(() => docToMarkdown(json(target))).not.toThrow();
  });

  it('blocks removing a task first paragraph when that would expose a colored paragraph as the title', () => {
    const source = [
      '- [ ] First <!-- background: blue -->',
      '',
      '  <!-- morrow:block-background:green -->',
      '',
      '  Second',
    ].join('\n');
    const target = make(markdownToDoc(source));
    const before = json(target);
    let firstParagraphPos = -1;
    let firstParagraphSize = 0;
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' && node.textContent === 'First') {
        firstParagraphPos = pos;
        firstParagraphSize = node.nodeSize;
      }
    });
    expect(firstParagraphPos).toBeGreaterThan(0);
    expect(json(target).content![0]!.content![0]!.content![1]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: 'green' },
    });

    target.view.dispatch(target.state.tr.delete(firstParagraphPos, firstParagraphPos + firstParagraphSize));

    expect(json(target)).toEqual(before);
    expect(() => docToMarkdown(json(target))).not.toThrow();
  });

  it('refuses list-item conversions that would discard either of two distinct backgrounds', () => {
    const targets = [
      { kind: 'paragraph' } as const,
      { kind: 'heading', level: 2 } as const,
      { kind: 'blockquote' } as const,
    ];
    for (const targetKind of targets) {
      editor?.destroy();
      editor = null;
      const target = make({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                attrs: { backgroundColor: 'yellow' },
                content: [{ ...p('First'), attrs: { backgroundColor: '#2f80ed' } }],
              },
            ],
          },
        ],
      });
      const before = json(target);
      const selection = target.state.selection;

      turnInto(target, 1, targetKind);

      expect(json(target), targetKind.kind).toEqual(before);
      expect(target.state.selection, targetKind.kind).toEqual(selection);
      expect(() => docToMarkdown(json(target))).not.toThrow();
    }
  });

  it('carries a sole native item palette onto its converted block', () => {
    const targets = [
      { kind: 'paragraph' } as const,
      { kind: 'heading', level: 2 } as const,
      { kind: 'blockquote' } as const,
    ];
    for (const targetKind of targets) {
      editor?.destroy();
      editor = null;
      const target = make({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                attrs: { backgroundColor: 'yellow' },
                content: [p('First')],
              },
            ],
          },
        ],
      });

      turnInto(target, 1, targetKind);

      const converted = json(target).content![0]!;
      const owner = converted.type === 'blockquote' ? converted.content?.[0] : converted;
      expect(owner, targetKind.kind).toMatchObject({ attrs: { backgroundColor: 'yellow' } });
      expect(docToMarkdown(markdownToDoc(docToMarkdown(json(target))))).toEqual(docToMarkdown(json(target)));
    }
  });

  it('keeps list paragraph and item palettes when turning an item into a lettered list', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [{ ...p('First'), attrs: { backgroundColor: '#2f80ed' } }],
            },
          ],
        },
      ],
    });

    turnInto(target, 1, { kind: 'letteredList' });

    const list = json(target).content![0]!;
    expect(list).toMatchObject({
      type: 'orderedList',
      attrs: { type: 'a' },
      content: [
        {
          type: 'listItem',
          attrs: { backgroundColor: 'yellow' },
          content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
        },
      ],
    });
    const saved = docToMarkdown(json(target));
    expect(saved).toContain('<!-- letters -->');
    expect(docToMarkdown(markdownToDoc(saved))).toBe(saved);
  });

  it('preserves HEX owners through StarterKit list shortcuts and undo', () => {
    for (const key of ['8', '7']) {
      const target = make({
        type: 'doc',
        content: [{ ...p('Shaded line'), attrs: { backgroundColor: '#2f80ed' } }],
      });
      const before = json(target);
      target.commands.setTextSelection(1);
      const shortcut = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true });
      const handled = target.view.someProp('handleKeyDown', (handler) => handler(target.view, shortcut));
      expect(handled, `Ctrl+Shift+${key}`).toBe(true);
      const list = json(target).content![0]!;
      expect(list.type, `Ctrl+Shift+${key}`).toBe(key === '8' ? 'bulletList' : 'orderedList');
      expect(list.content![0]!.content![0]).toMatchObject({
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
      });
      const converted = json(target);
      const serialized = docToMarkdown(converted);
      expect(docToMarkdown(markdownToDoc(serialized))).toEqual(serialized);

      let end = -1;
      target.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'Shaded line') end = pos + node.nodeSize;
      });
      expect(end).toBeGreaterThan(0);
      target.view.dispatch(target.state.tr.insertText(' edited', end));
      expect(docToMarkdown(json(target))).toContain('Shaded line edited');
      expect(() => docToMarkdown(json(target))).not.toThrow();
      expect(target.commands.undo()).toBe(true);
      expect(json(target)).toEqual(converted);
      expect(target.commands.undo()).toBe(true);
      expect(json(target)).toEqual(before);
      expect(target.commands.undo()).toBe(false);
      target.destroy();
      editor = null;
    }

    for (const backgroundColor of [null, 'green']) {
      const target = make({
        type: 'doc',
        content: [
          {
            ...p('Safe line'),
            ...(backgroundColor ? { attrs: { backgroundColor } } : {}),
          },
        ],
      });
      target.commands.setTextSelection(1);
      const key = '8';
      const shortcut = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true });
      expect(target.view.someProp('handleKeyDown', (handler) => handler(target.view, shortcut))).toBe(true);
      expect(json(target).content![0]!.type).toBe('bulletList');
      expect(() => docToMarkdown(json(target))).not.toThrow();
      expect(target.commands.undo()).toBe(true);
      expect(json(target).content![0]!.type).toBe('paragraph');
      target.destroy();
      editor = null;
    }
  });

  it('allows custom HEX insertion at a supported top-level owner', () => {
    const target = make({ type: 'doc', content: [p('Above')] });
    const insertAt = target.state.doc.content.size;
    expect(
      target.commands.insertContentAt(insertAt, {
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
        content: [{ type: 'text', text: 'Inserted color' }],
      }),
    ).toBe(true);
    const inserted = json(target).content!.find((node) => node.attrs?.backgroundColor === '#2f80ed');
    expect(inserted).toMatchObject({ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } });
    expect(() => docToMarkdown(json(target))).not.toThrow();
  });

  it('allows HEX ownership on a direct list paragraph and rejects a task first paragraph', () => {
    const color = '#2f80ed';
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [p('List item')] }],
        },
      ],
    });
    let paragraphPos = -1;
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph') paragraphPos = pos;
    });
    expect(paragraphPos).toBeGreaterThan(0);
    target.view.dispatch(
      target.state.tr.setNodeMarkup(paragraphPos, undefined, {
        ...target.state.doc.nodeAt(paragraphPos)!.attrs,
        backgroundColor: color,
      }),
    );
    expect(json(target).content?.[0]?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: color },
    });
    const saved = docToMarkdown(json(target));
    expect(saved).toContain('<!-- morrow:block-background:#2f80ed -->');
    expect(docToMarkdown(markdownToDoc(saved))).toEqual(saved);

    for (const backgroundColor of [color, 'green']) {
      const task = make({
        type: 'doc',
        content: [
          {
            type: 'taskList',
            content: [
              { type: 'taskItem', attrs: { checked: false }, content: [p('Task first line'), p('later')] },
            ],
          },
        ],
      });
      let taskParagraphPos = -1;
      task.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent === 'Task first line') taskParagraphPos = pos;
      });
      const before = json(task);
      task.view.dispatch(
        task.state.tr.setNodeMarkup(taskParagraphPos, undefined, {
          ...task.state.doc.nodeAt(taskParagraphPos)!.attrs,
          backgroundColor,
        }),
      );
      expect(json(task)).toEqual(before);
      expect(docToMarkdown(json(task))).not.toContain('morrow:block-background');
      task.destroy();
      editor = null;
    }
  });

  it('keeps list paragraph backgrounds through paste, keyboard split, and undo', () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const source = `- \n  ${marker}\n\n  Pasted colored item\n`;
    const target = make({ type: 'doc', content: [p('Above'), p(''), p('Below')] });
    const original = json(target);
    const start = target.state.doc.child(0).nodeSize + 1;
    target.commands.setTextSelection(start);
    const event = {
      clipboardData: { types: ['text/plain'], getData: () => source },
    } as unknown as ClipboardEvent;
    let handled = false;
    target.view.someProp('handlePaste', (handler) => {
      const result = handler(target.view, event, target.state.doc.slice(0, 0));
      if (result) handled = true;
      return result;
    });
    expect(handled).toBe(true);
    const listItem = json(target).content?.find((node) => node.type === 'bulletList')?.content?.[0];
    expect(listItem?.content?.[0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: '#2f80ed' },
    });
    expect(docToMarkdown(markdownToDoc(docToMarkdown(json(target))))).toEqual(docToMarkdown(json(target)));
    expect(target.commands.undo()).toBe(true);
    expect(json(target)).toEqual(original);

    const keyboard = make(markdownToDoc(source));
    let end = -1;
    keyboard.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Pasted colored item') end = pos + node.nodeSize;
    });
    expect(end).toBeGreaterThan(0);
    keyboard.commands.setTextSelection(end);
    const enter = new KeyboardEvent('keydown', { key: 'Enter' });
    keyboard.view.someProp('handleKeyDown', (handler) => handler(keyboard.view, enter));
    expect(() => docToMarkdown(json(keyboard))).not.toThrow();
    const colors: string[] = [];
    keyboard.state.doc.descendants((node) => {
      if (node.type.name === 'paragraph' && node.attrs.backgroundColor === '#2f80ed')
        colors.push(node.textContent);
    });
    expect(colors.length).toBeGreaterThan(0);
    expect(keyboard.commands.undo()).toBe(true);
    expect(docToMarkdown(markdownToDoc(docToMarkdown(json(keyboard))))).toEqual(
      docToMarkdown(json(keyboard)),
    );
  });

  it('flushes and reopens a colored list item after its keyboard conversion', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const notePath = 'Notes.md';
    const vault = new MemoryVault({
      [notePath]: `${marker}\n\nShaded line\n`,
      '.morrow/workspace.json': JSON.stringify({ version: 1, pages: { [notePath]: { id: 'note-page' } } }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    try {
      expect(session.protectedReasons.has('note-page')).toBe(false);
      const target = make(session.getState().docs['note-page']);
      target.commands.setTextSelection(1);
      const shortcut = new KeyboardEvent('keydown', { key: '8', ctrlKey: true, shiftKey: true });
      target.view.someProp('handleKeyDown', (handler) => handler(target.view, shortcut));
      expect(json(target).content![0]!.type).toBe('bulletList');
      expect(json(target).content![0]!.content![0]!.content![0]).toMatchObject({
        type: 'paragraph',
        attrs: { backgroundColor: '#2f80ed' },
      });

      let end = -1;
      target.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'Shaded line') end = pos + node.nodeSize;
      });
      expect(end).toBeGreaterThan(0);
      target.view.dispatch(target.state.tr.insertText(' edited', end));
      expect(() => docToMarkdown(json(target))).not.toThrow();
      expect(session.execute({ type: 'page.setDoc', id: 'note-page', doc: json(target), now: 43 }).ok).toBe(
        true,
      );
      expect(await session.flush()).toBe(true);
      expect(vault.text(notePath)).toContain('Shaded line edited');
      expect(vault.text(notePath)).toContain(marker);
      target.destroy();
      editor = null;

      await session.close();
      const reopened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!reopened.ok) throw new Error(reopened.error);
      try {
        expect(reopened.value.protectedReasons.has('note-page')).toBe(false);
        expect(
          reopened.value.getState().docs['note-page']!.content?.[0]?.content?.[0]?.content?.[0]?.attrs
            ?.backgroundColor,
        ).toBe('#2f80ed');
      } finally {
        await reopened.value.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('preserves list backgrounds through protected shortcuts, empty-line Enter, and slash dispatch', async () => {
    const color = '#2f80ed';
    const listPath = 'List shortcut.md';
    const taskPath = 'Task empty line.md';
    const codePath = 'Slash code.md';
    const togglePath = 'Slash toggle.md';
    const listSource = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { backgroundColor: 'yellow' },
              content: [{ ...p('First'), attrs: { backgroundColor: color } }],
            },
            { type: 'listItem', content: [p('Keep')] },
          ],
        },
      ],
    } as DocNode);
    const taskSource = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [p('Task'), { ...p(''), attrs: { backgroundColor: color } }],
            },
          ],
        },
      ],
    } as DocNode);
    const coloredSlashSource = (trigger: '/code' | '/toggle') =>
      docToMarkdown({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ ...p(trigger), attrs: { backgroundColor: 'green' } }],
              },
            ],
          },
        ],
      } as DocNode);
    const codeSource = coloredSlashSource('/code');
    const toggleSource = coloredSlashSource('/toggle');
    const notePaths = [listPath, taskPath, codePath, togglePath];
    const noteIds = ['shortcut-list', 'empty-task-line', 'slash-code', 'slash-toggle'];
    const sources = [listSource, taskSource, codeSource, toggleSource];
    const vault = new MemoryVault({
      ...Object.fromEntries(notePaths.map((path, index) => [path, sources[index]])),
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: Object.fromEntries(notePaths.map((path, index) => [path, { id: noteIds[index] }])),
      }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    try {
      const shortcutEditor = make(session.getState().docs['shortcut-list']!);
      const beforeShortcut = json(shortcutEditor);
      let firstText = -1;
      shortcutEditor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'First') firstText = pos;
      });
      expect(firstText).toBeGreaterThan(0);
      shortcutEditor.commands.setTextSelection(firstText);
      const shortcut = new KeyboardEvent('keydown', {
        key: '8',
        code: 'Digit8',
        ctrlKey: true,
        shiftKey: true,
      });
      let shortcutHandled = false;
      shortcutEditor.view.someProp('handleKeyDown', (handler) => {
        const handled = handler(shortcutEditor.view, shortcut);
        if (handled) shortcutHandled = true;
        return handled;
      });
      expect(shortcutHandled).toBe(true);
      expect(json(shortcutEditor)).toEqual(beforeShortcut);

      const deletionControl = make(session.getState().docs['shortcut-list']!);
      const firstItem = deletionControl.state.doc.nodeAt(1)!;
      deletionControl.view.dispatch(
        deletionControl.state.tr.delete(1, 1 + firstItem.nodeSize),
      );
      expect(
        json(deletionControl).content![0]!.content!.map((item) => item.content?.[0]?.content?.[0]?.text),
      ).toEqual(['Keep']);
      deletionControl.destroy();
      editor = null;

      const nestedShortcutEditor = make({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  p('Parent'),
                  {
                    type: 'bulletList',
                    content: [
                      {
                        type: 'listItem',
                        attrs: { backgroundColor: 'yellow' },
                        content: [{ ...p('Nested'), attrs: { backgroundColor: color } }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      const beforeNestedShortcut = json(nestedShortcutEditor);
      let nestedText = -1;
      nestedShortcutEditor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'Nested') nestedText = pos;
      });
      expect(nestedText).toBeGreaterThan(0);
      nestedShortcutEditor.commands.setTextSelection(nestedText);
      const nestedShortcut = new KeyboardEvent('keydown', {
        key: '8',
        code: 'Digit8',
        ctrlKey: true,
        shiftKey: true,
      });
      let nestedShortcutHandled = false;
      nestedShortcutEditor.view.someProp('handleKeyDown', (handler) => {
        const handled = handler(nestedShortcutEditor.view, nestedShortcut);
        if (handled) nestedShortcutHandled = true;
        return handled;
      });
      expect(nestedShortcutHandled).toBe(true);
      expect(json(nestedShortcutEditor)).toEqual(beforeNestedShortcut);
      nestedShortcutEditor.destroy();
      editor = null;

      const taskEditor = make(session.getState().docs['empty-task-line']!);
      let emptyColoredParagraph = -1;
      taskEditor.state.doc.descendants((node, pos) => {
        if (
          node.type.name === 'paragraph' &&
          node.content.size === 0 &&
          node.attrs.backgroundColor === color
        ) {
          emptyColoredParagraph = pos;
        }
      });
      expect(emptyColoredParagraph).toBeGreaterThan(0);
      taskEditor.commands.setTextSelection(emptyColoredParagraph + 1);
      const enter = new KeyboardEvent('keydown', { key: 'Enter' });
      let enterHandled = false;
      taskEditor.view.someProp('handleKeyDown', (handler) => {
        const handled = handler(taskEditor.view, enter);
        if (handled) enterHandled = true;
        return handled;
      });
      expect(enterHandled).toBe(true);
      const rootLine = json(taskEditor).content!.find(
        (node) => node.type === 'paragraph' && node.attrs?.backgroundColor === color,
      );
      expect(rootLine).toBeDefined();
      const taskSaved = docToMarkdown(json(taskEditor));
      expect(taskSaved).toContain(`<!-- morrow:block-background:${color} -->`);
      expect(docToMarkdown(markdownToDoc(taskSaved))).toBe(taskSaved);

      for (const [path, id, trigger, commandId] of [
        [codePath, 'slash-code', '/code', 'code'],
        [togglePath, 'slash-toggle', '/toggle', 'toggle'],
      ] as const) {
        const slashEditor = make(session.getState().docs[id]!);
        const beforeSlash = json(slashEditor);
        let triggerStart = -1;
        slashEditor.state.doc.descendants((node, pos) => {
          if (node.isText && node.text === trigger) triggerStart = pos;
        });
        expect(triggerStart).toBeGreaterThan(0);
        const triggerEnd = triggerStart + trigger.length;
        slashEditor.commands.setTextSelection(triggerEnd);
        const command = BLOCK_ITEMS.find((entry) => entry.id === commandId)!;
        command.run(slashEditor, { from: triggerStart, to: triggerEnd }, { createChild: () => null });
        expect(json(slashEditor), path).toEqual(beforeSlash);
        slashEditor.destroy();
        editor = null;
      }

      const baselineToggle = make({
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [{ type: 'listItem', content: [p('Baseline/toggle')] }],
          },
        ],
      });
      let toggleStart = -1;
      baselineToggle.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'Baseline/toggle') toggleStart = pos + 'Baseline'.length;
      });
      const toggleEnd = toggleStart + '/toggle'.length;
      baselineToggle.commands.setTextSelection(toggleEnd);
      BLOCK_ITEMS.find((entry) => entry.id === 'toggle')!.run(
        baselineToggle,
        { from: toggleStart, to: toggleEnd },
        { createChild: () => null },
      );
      expect(json(baselineToggle).content![0]!.type).toBe('details');
      baselineToggle.destroy();
      editor = null;

      expect(
        session.execute({ type: 'page.setDoc', id: 'empty-task-line', doc: json(taskEditor), now: 46 }).ok,
      ).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(vault.text(listPath)).toBe(listSource);
      expect(vault.text(codePath)).toBe(codeSource);
      expect(vault.text(togglePath)).toBe(toggleSource);
      expect(vault.text(taskPath)).toContain(`<!-- morrow:block-background:${color} -->`);
      taskEditor.destroy();
      editor = null;

      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      for (const id of noteIds) expect(reopened.protectedReasons.has(id), id).toBe(false);
      expect(reopened.getState().docs['shortcut-list']!.content![0]!.content![0]).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [{ type: 'paragraph', attrs: { backgroundColor: color } }],
      });
      expect(reopened.getState().docs['empty-task-line']!.content).toContainEqual(
        expect.objectContaining({ type: 'paragraph', attrs: expect.objectContaining({ backgroundColor: color }) }),
      );
      for (const id of ['slash-code', 'slash-toggle']) {
        const trigger = id === 'slash-code' ? '/code' : '/toggle';
        expect(reopened.getState().docs[id]!.content![0]!.content![0]!.content![0]).toMatchObject({
          type: 'paragraph',
          attrs: { backgroundColor: 'green' },
          content: [{ text: trigger }],
        });
      }
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('guards only list shortcuts whose lift cannot represent both background owners', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const palette = '<!-- background: yellow -->';
    const fixtures = [
      {
        path: 'Ordered dual.md',
        id: 'ordered-dual',
        source: `1. \n   ${marker}\n\n   First ${palette}\n\n2. Second\n\nNeighbor\n`,
        key: '7',
        find: 'First',
        expected: 'blocked',
      },
      {
        path: 'Selected middle dual.md',
        id: 'selected-middle',
        source: `- Head\n- \n  ${marker}\n\n  First ${palette}\n- Tail\n\nNeighbor\n`,
        key: '8',
        find: 'Head',
        expected: 'blocked',
      },
      {
        path: 'Backspace dual.md',
        id: 'backspace-dual',
        source: `- \n  ${marker}\n\n  First ${palette}\n\n- Second\n\nNeighbor\n`,
        key: 'Backspace',
        find: 'First',
        expected: 'blocked',
      },
      {
        path: 'Task owners.md',
        id: 'task-owners',
        source: `- [ ] First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: '9',
        find: 'First',
        expected: 'converted',
      },
    ] as const;
    const vault = new MemoryVault({
      ...Object.fromEntries(fixtures.map(({ path, source }) => [path, source])),
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: Object.fromEntries(fixtures.map(({ path, id }) => [path, { id }])),
      }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    try {
      const firstTextPosition = (target: Editor, text: string) => {
        let position = -1;
        target.state.doc.descendants((node, pos) => {
          if (node.isText && typeof node.text === 'string' && node.text.includes(text) && position < 0)
            position = pos + node.text.indexOf(text);
        });
        return position;
      };
      const press = (
        target: Editor,
        key: string,
        selection: number | { from: number; to: number },
        modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; code?: string } = {},
      ) => {
        target.commands.setTextSelection(selection);
        const event = new KeyboardEvent('keydown', { key, ...modifiers });
        let handled = false;
        target.view.someProp('handleKeyDown', (handler) => {
          const result = handler(target.view, event);
          if (result) handled = true;
          return result;
        });
        return handled;
      };

      for (const fixture of fixtures) {
        const target = make(session.getState().docs[fixture.id]!);
        const before = target.state.doc;
        const position = firstTextPosition(target, fixture.find);
        expect(position, fixture.id).toBeGreaterThan(0);
        const selection =
          fixture.id === 'selected-middle'
            ? { from: position + 1, to: firstTextPosition(target, 'Tail') + 2 }
            : position;
        const handled = press(
          target,
          fixture.key,
          selection,
          fixture.key === 'Backspace'
            ? {}
            : { ctrlKey: true, shiftKey: true, code: `Digit${fixture.key}` },
        );
        expect(handled, fixture.id).toBe(true);
        if (fixture.expected === 'blocked') {
          expect(target.state.doc.eq(before), fixture.id).toBe(true);
        } else {
          expect(target.state.doc.eq(before), fixture.id).toBe(false);
          expect(json(target).content![0]).toMatchObject({
            type: 'paragraph',
            attrs: { backgroundColor: 'yellow' },
            content: [{ text: 'First' }],
          });
          expect(json(target).content![1]).toMatchObject({
            type: 'paragraph',
            attrs: { backgroundColor: '#2f80ed' },
            content: [{ text: 'Second line' }],
          });
          expect(docToMarkdown(markdownToDoc(docToMarkdown(json(target))))).toBe(
            docToMarkdown(json(target)),
          );
        }
        expect(
          session.execute({ type: 'page.setDoc', id: fixture.id, doc: json(target), now: 47 }).ok,
          fixture.id,
        ).toBe(true);
        target.destroy();
        editor = null;
      }

      const nativeOnly = make(markdownToDoc(`- First ${palette}\n\n- Second\n`));
      const nativeStart = firstTextPosition(nativeOnly, 'First');
      const nativeBefore = nativeOnly.state.doc;
      expect(press(nativeOnly, '8', nativeStart, { ctrlKey: true, shiftKey: true, code: 'Digit8' })).toBe(
        true,
      );
      expect(nativeOnly.state.doc.eq(nativeBefore)).toBe(false);
      nativeOnly.destroy();
      editor = null;

      const hexOnly = make(markdownToDoc(`- \n  ${marker}\n\n  First\n\n- Second\n`));
      const hexStart = firstTextPosition(hexOnly, 'First');
      const hexBefore = hexOnly.state.doc;
      expect(press(hexOnly, '8', hexStart, { ctrlKey: true, shiftKey: true, code: 'Digit8' })).toBe(true);
      expect(hexOnly.state.doc.eq(hexBefore)).toBe(false);
      expect(docToMarkdown(json(hexOnly))).toContain(marker);
      hexOnly.destroy();
      editor = null;

      expect(await session.flush()).toBe(true);
      for (const fixture of fixtures) {
        const saved = vault.text(fixture.path)!;
        expect(saved, fixture.id).toContain(marker);
        expect(saved, fixture.id).toContain(palette);
        expect(saved, fixture.id).toContain('Neighbor');
      }
      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      for (const fixture of fixtures) expect(reopened.protectedReasons.has(fixture.id), fixture.id).toBe(false);
      const ordered = reopened.getState().docs['ordered-dual']!.content![0]!.content![0]!;
      expect(ordered).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
      });
      const selectedMiddle = reopened.getState().docs['selected-middle']!.content![0]!.content![1]!;
      expect(selectedMiddle).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
      });
      const backspaceItem = reopened.getState().docs['backspace-dual']!.content![0]!.content![0]!;
      expect(backspaceItem).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
      });
      expect(reopened.getState().docs['task-owners']!.content!.slice(0, 2)).toMatchObject([
        { type: 'paragraph', attrs: { backgroundColor: 'yellow' }, content: [{ text: 'First' }] },
        { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [{ text: 'Second line' }] },
      ]);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('blocks only background-losing task conversions and forward list joins', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const palette = '<!-- background: yellow -->';
    const fixtures = [
      {
        path: 'Task to bullet.md',
        id: 'task-to-bullet',
        source: `- [ ] First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: '8',
        find: 'First',
        modifiers: { ctrlKey: true, shiftKey: true, code: 'Digit8' },
        expected: 'blocked',
      },
      {
        path: 'Bullet to task.md',
        id: 'bullet-to-task',
        source: `- First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: '9',
        find: 'First',
        modifiers: { ctrlKey: true, shiftKey: true, code: 'Digit9' },
        expected: 'blocked',
      },
      {
        path: 'Forward join.md',
        id: 'forward-join',
        source: `- Before\n\n- First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: 'Delete',
        find: 'Before',
        modifiers: {},
        expected: 'blocked',
      },
      {
        path: 'Bullet to ordered.md',
        id: 'bullet-to-ordered',
        source: `- First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: '7',
        find: 'First',
        modifiers: { ctrlKey: true, shiftKey: true, code: 'Digit7' },
        expected: 'converted',
      },
      {
        path: 'Explicit delete.md',
        id: 'explicit-delete',
        source: `- Before\n\n- First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        key: 'Delete',
        find: 'Before',
        modifiers: {},
        expected: 'text-delete',
      },
    ] as const;
    const vault = new MemoryVault({
      ...Object.fromEntries(fixtures.map(({ path, source }) => [path, source])),
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: Object.fromEntries(fixtures.map(({ path, id }) => [path, { id }])),
      }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    const editors: Editor[] = [];
    try {
      const firstTextPosition = (target: Editor, text: string) => {
        let position = -1;
        target.state.doc.descendants((node, pos) => {
          if (node.isText && typeof node.text === 'string' && node.text.includes(text) && position < 0)
            position = pos + node.text.indexOf(text);
        });
        return position;
      };
      const press = (
        target: Editor,
        key: string,
        position: number,
        modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; code?: string },
      ) => {
        target.commands.setTextSelection(position);
        const event = new KeyboardEvent('keydown', { key, ...modifiers });
        let handled = false;
        target.view.someProp('handleKeyDown', (handler) => {
          const result = handler(target.view, event);
          if (result) handled = true;
          return result;
        });
        return handled;
      };

      for (const fixture of fixtures) {
        const target = make(session.getState().docs[fixture.id]!);
        editors.push(target);
        const position = firstTextPosition(target, fixture.find);
        expect(position, fixture.id).toBeGreaterThan(0);
        const before = target.state.doc;
        const cursor =
          fixture.key === 'Delete' && fixture.expected === 'text-delete'
            ? position + 1
            : fixture.key === 'Delete'
              ? position + fixture.find.length
              : position;
        const handled = press(target, fixture.key, cursor, fixture.modifiers);

        if (fixture.expected === 'blocked') {
          expect(handled, fixture.id).toBe(true);
          expect(target.state.doc.eq(before), fixture.id).toBe(true);
        } else if (fixture.expected === 'converted') {
          expect(handled, fixture.id).toBe(true);
          expect(target.state.doc.eq(before), fixture.id).toBe(false);
          expect(json(target).content![0]!.type).toBe('orderedList');
          expect(docToMarkdown(markdownToDoc(docToMarkdown(json(target))))).toBe(docToMarkdown(json(target)));
        } else {
          expect(handled, fixture.id).toBe(false);
          target.view.dispatch(target.state.tr.delete(cursor, cursor + 1));
          expect(docToMarkdown(json(target))).toContain('Bfore');
        }

        expect(
          session.execute({ type: 'page.setDoc', id: fixture.id, doc: json(target), now: 48 }).ok,
          fixture.id,
        ).toBe(true);
      }

      expect(await session.flush()).toBe(true);
      for (const fixture of fixtures) {
        const saved = vault.text(fixture.path)!;
        expect(saved, fixture.id).toContain('Neighbor');
        if (fixture.expected === 'blocked' || fixture.expected === 'converted') {
          expect(saved, fixture.id).toContain(marker);
          expect(saved, fixture.id).toContain(palette);
        }
      }
      expect(vault.text('Bullet to ordered.md')).toMatch(/^1\. First/);
      expect(vault.text('Explicit delete.md')).toContain('Bfore');

      for (const target of editors) target.destroy();
      editors.length = 0;
      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      for (const fixture of fixtures) expect(reopened.protectedReasons.has(fixture.id), fixture.id).toBe(false);
      expect(reopened.getState().docs['task-to-bullet']!.content![0]!.type).toBe('taskList');
      expect(reopened.getState().docs['bullet-to-task']!.content![0]!.type).toBe('bulletList');
      expect(reopened.getState().docs['forward-join']!.content![0]!.content).toHaveLength(2);
      expect(reopened.getState().docs['forward-join']!.content![0]!.content![1]).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [
          { type: 'paragraph', content: [{ text: 'First' }] },
          { type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [{ text: 'Second line' }] },
        ],
      });
      expect(reopened.getState().docs['bullet-to-ordered']!.content![0]!.type).toBe('orderedList');
      expect(docToMarkdown(reopened.getState().docs['explicit-delete']!)).toContain('Bfore');
    } finally {
      for (const target of editors) target.destroy();
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('preflights Delete before joining the first list owner into the preceding paragraph', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const palette = '<!-- background: yellow -->';
    const fixtures = [
      {
        path: 'Boundary task dual.md',
        id: 'boundary-task-dual',
        source: `Before\n\n- [ ] First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        expected: 'blocked',
      },
      {
        path: 'Boundary bullet first dual.md',
        id: 'boundary-bullet-first-dual',
        source: `Before\n\n- \n  ${marker}\n\n  First ${palette}\n\n- Second\n\nNeighbor\n`,
        expected: 'blocked',
      },
      {
        path: 'Boundary bullet later dual.md',
        id: 'boundary-bullet-later-dual',
        source: `Before\n\n- First ${palette}\n\n  ${marker}\n\n  Second line\n\n- Second\n\nNeighbor\n`,
        expected: 'blocked',
      },
      {
        path: 'Boundary HEX only first.md',
        id: 'boundary-hex-only-first',
        source: `Before\n\n- \n  ${marker}\n\n  First\n\n- Second\n\nNeighbor\n`,
        expected: 'blocked',
      },
      {
        path: 'Boundary native only.md',
        id: 'boundary-native-only',
        source: `Before\n\n- First ${palette}\n\n- Second\n\nNeighbor\n`,
        expected: 'joined',
      },
      {
        path: 'Boundary plain.md',
        id: 'boundary-plain',
        source: 'Before\n\n- First\n\n- Second\n\nNeighbor\n',
        expected: 'joined',
      },
    ] as const;
    const vault = new MemoryVault({
      ...Object.fromEntries(fixtures.map(({ path, source }) => [path, source])),
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: Object.fromEntries(fixtures.map(({ path, id }) => [path, { id }])),
      }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    const editors: Editor[] = [];
    try {
      const firstTextPosition = (target: Editor, text: string) => {
        let position = -1;
        target.state.doc.descendants((node, pos) => {
          if (node.isText && typeof node.text === 'string' && node.text.includes(text) && position < 0)
            position = pos + node.text.indexOf(text);
        });
        return position;
      };
      for (const fixture of fixtures) {
        const target = make(session.getState().docs[fixture.id]!);
        editors.push(target);
        const position = firstTextPosition(target, 'Before');
        expect(position, fixture.id).toBeGreaterThan(0);
        const before = target.state.doc;
        target.commands.setTextSelection(position + 'Before'.length);
        const event = new KeyboardEvent('keydown', { key: 'Delete' });
        let handled = false;
        target.view.someProp('handleKeyDown', (handler) => {
          const result = handler(target.view, event);
          if (result) handled = true;
          return result;
        });

        expect(handled, fixture.id).toBe(true);
        if (fixture.expected === 'blocked') {
          expect(target.state.doc.eq(before), fixture.id).toBe(true);
        } else {
          expect(target.state.doc.eq(before), fixture.id).toBe(false);
          expect(docToMarkdown(json(target))).toContain('BeforeFirst');
        }
        expect(
          session.execute({ type: 'page.setDoc', id: fixture.id, doc: json(target), now: 49 }).ok,
          fixture.id,
        ).toBe(true);
      }

      expect(await session.flush()).toBe(true);
      for (const fixture of fixtures) {
        const saved = vault.text(fixture.path)!;
        expect(saved, fixture.id).toContain('Neighbor');
        if (fixture.expected === 'blocked') {
          expect(saved, fixture.id).toContain(marker);
          if (fixture.id !== 'boundary-hex-only-first') expect(saved, fixture.id).toContain(palette);
        }
      }

      for (const target of editors) target.destroy();
      editors.length = 0;
      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      for (const fixture of fixtures) expect(reopened.protectedReasons.has(fixture.id), fixture.id).toBe(false);
      for (const fixture of fixtures.filter((entry) => entry.expected === 'blocked')) {
        expect(reopened.getState().docs[fixture.id]!.content![0]!.type, fixture.id).toBe('paragraph');
      }
      for (const fixture of fixtures.filter((entry) => entry.expected === 'joined')) {
        expect(docToMarkdown(reopened.getState().docs[fixture.id]!)).toContain('BeforeFirst');
      }
    } finally {
      for (const target of editors) target.destroy();
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('preflights the actual Delete join and leaves an empty line before a list removable', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const palette = '<!-- background: yellow -->';
    const fixtures = [
      {
        path: 'Same item paragraph join.md',
        id: 'same-item-paragraph-join',
        source: `- [ ] First ${palette}\n\n  ${marker}\n\n  Second line\n\nNeighbor\n`,
        find: 'First',
        expected: 'blocked',
      },
      {
        path: 'Next item HEX only.md',
        id: 'next-item-hex-only',
        source: `- Before\n- \n  ${marker}\n\n  First\n\nNeighbor\n`,
        find: 'Before',
        expected: 'blocked',
      },
      {
        path: 'Different list dual.md',
        id: 'different-list-dual',
        source: `- Before\n\n1. First ${palette}\n\n   ${marker}\n\n   Second line\n\nNeighbor\n`,
        find: 'Before',
        expected: 'blocked',
      },
      {
        path: 'Empty before dual.md',
        id: 'empty-before-dual',
        source: `- \n  ${marker}\n\n  First ${palette}\n\n- Second\n\nNeighbor\n`,
        find: 'First',
        expected: 'empty-removed',
      },
    ] as const;
    const vault = new MemoryVault({
      ...Object.fromEntries(fixtures.map(({ path, source }) => [path, source])),
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: Object.fromEntries(fixtures.map(({ path, id }) => [path, { id }])),
      }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    const editors: Editor[] = [];
    try {
      const firstTextPosition = (target: Editor, text: string) => {
        let position = -1;
        target.state.doc.descendants((node, pos) => {
          if (node.isText && typeof node.text === 'string' && node.text.includes(text) && position < 0)
            position = pos + node.text.indexOf(text);
        });
        return position;
      };

      for (const fixture of fixtures) {
        const target = make(session.getState().docs[fixture.id]!);
        editors.push(target);
        if (fixture.expected === 'empty-removed') {
          target.commands.insertContentAt(0, { type: 'paragraph' });
          expect(target.state.doc.firstChild?.type.name, fixture.id).toBe('paragraph');
          expect(target.state.doc.firstChild?.content.size, fixture.id).toBe(0);
          target.commands.setTextSelection(1);
        } else {
          const position = firstTextPosition(target, fixture.find);
          expect(position, fixture.id).toBeGreaterThan(0);
          target.commands.setTextSelection(position + fixture.find.length);
        }

        const before = target.state.doc;
        const event = new KeyboardEvent('keydown', { key: 'Delete' });
        let handled = false;
        target.view.someProp('handleKeyDown', (handler) => {
          const result = handler(target.view, event);
          if (result) handled = true;
          return result;
        });
        expect(handled, fixture.id).toBe(true);

        if (fixture.expected === 'blocked') {
          expect(target.state.doc.eq(before), fixture.id).toBe(true);
        } else {
          expect(target.state.doc.eq(before), fixture.id).toBe(false);
          expect(target.state.doc.firstChild?.type.name, fixture.id).toBe('bulletList');
        }
        expect(
          session.execute({ type: 'page.setDoc', id: fixture.id, doc: json(target), now: 50 }).ok,
          fixture.id,
        ).toBe(true);
      }

      expect(await session.flush()).toBe(true);
      for (const fixture of fixtures) {
        const saved = vault.text(fixture.path)!;
        expect(saved, fixture.id).toContain(marker);
        if (fixture.id !== 'next-item-hex-only') expect(saved, fixture.id).toContain(palette);
        expect(saved, fixture.id).toContain('Neighbor');
      }

      for (const target of editors) target.destroy();
      editors.length = 0;
      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      for (const fixture of fixtures) expect(reopened.protectedReasons.has(fixture.id), fixture.id).toBe(false);
      expect(reopened.getState().docs['same-item-paragraph-join']!.content![0]!.type).toBe('taskList');
      expect(reopened.getState().docs['next-item-hex-only']!.content![0]!.type).toBe('bulletList');
      expect(reopened.getState().docs['different-list-dual']!.content![0]!.type).toBe('bulletList');
      expect(reopened.getState().docs['empty-before-dual']!.content![0]!.type).toBe('bulletList');
      expect(docToMarkdown(reopened.getState().docs['empty-before-dual']!)).toContain(marker);
    } finally {
      for (const target of editors) target.destroy();
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('keeps selected colored owners out of unsupported multi-block conversions', () => {
    const target = make({
      type: 'doc',
      content: [{ ...p('Shaded line'), attrs: { backgroundColor: '#2f80ed' } }, p('Following line')],
    });
    const before = json(target);
    const range = { from: 0, to: target.state.doc.content.size };
    turnBlocks(target, range, { kind: 'callout' });
    expect(json(target).content![0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: '#2f80ed' },
    });
    expect(json(target).content![1]!.content![0]!.text).toBe(before.content![1]!.content![0]!.text);
  });

  it('keeps the custom background on an empty paragraph created by deleting its text', () => {
    const target = make({
      type: 'doc',
      content: [{ ...p('Delete me'), attrs: { backgroundColor: '#2f80ed' } }],
    });
    target.commands.setTextSelection({ from: 1, to: 10 });
    target.commands.deleteSelection();
    expect(json(target).content![0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: '#2f80ed' },
    });
    const serialized = docToMarkdown(json(target));
    expect(serialized).toContain('<!-- morrow:block-background:#2f80ed -->\n<br>');
    expect(markdownToDoc(serialized)).toMatchObject({
      content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [] }],
    });
    expect(target.commands.undo()).toBe(true);
    expect(json(target).content![0]).toMatchObject({
      type: 'paragraph',
      attrs: { backgroundColor: '#2f80ed' },
      content: [{ text: 'Delete me' }],
    });
  });

  it('flushes and reopens a list paragraph cleared beside a native item palette', async () => {
    const marker = '<!-- morrow:block-background:#2f80ed -->';
    const notePath = 'List empty with palette.md';
    const source = `- \n  ${marker}\n\n  First <!-- background: yellow -->\n`;
    const vault = new MemoryVault({
      [notePath]: source,
      '.morrow/workspace.json': JSON.stringify({ version: 1, pages: { [notePath]: { id: 'list-empty' } } }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    try {
      expect(session.protectedReasons.has('list-empty')).toBe(false);
      const target = make(session.getState().docs['list-empty']);
      let textPos = -1;
      target.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'First') textPos = pos;
      });
      expect(textPos).toBeGreaterThan(0);
      target.view.dispatch(target.state.tr.delete(textPos, textPos + 'First'.length));
      expect(json(target).content![0]!.content![0]!.attrs?.backgroundColor).toBe('yellow');
      expect(json(target).content![0]!.content![0]!.content![0]!.attrs?.backgroundColor).toBe('#2f80ed');

      expect(session.execute({ type: 'page.setDoc', id: 'list-empty', doc: json(target), now: 44 }).ok).toBe(
        true,
      );
      expect(await session.flush()).toBe(true);
      const saved = vault.text(notePath)!;
      expect(saved).toContain(marker);
      expect(saved).toContain('<br> <!-- background: yellow -->');
      expect(target.commands.undo()).toBe(true);
      expect(json(target)).toMatchObject({
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                attrs: { backgroundColor: 'yellow' },
                content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' } }],
              },
            ],
          },
        ],
      });
      target.destroy();
      editor = null;

      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      expect(reopened.protectedReasons.has('list-empty')).toBe(false);
      expect(reopened.getState().docs['list-empty']!.content![0]!.content![0]).toMatchObject({
        attrs: { backgroundColor: 'yellow' },
        content: [{ type: 'paragraph', attrs: { backgroundColor: '#2f80ed' }, content: [] }],
      });
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('blocks a task title deletion that would turn a later palette paragraph into the title, then saves an edit', async () => {
    const marker = '<!-- morrow:block-background:green -->';
    const notePath = 'Task palette.md';
    const source = `- [ ] First <!-- background: blue -->\n\n  ${marker}\n\n  Second\n`;
    const vault = new MemoryVault({
      [notePath]: source,
      '.morrow/workspace.json': JSON.stringify({ version: 1, pages: { [notePath]: { id: 'task-page' } } }),
    });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    let session: WorkspaceSession | undefined = opened.value;
    let reopened: WorkspaceSession | undefined;
    try {
      expect(session.protectedReasons.has('task-page')).toBe(false);
      const target = make(session.getState().docs['task-page']);
      const before = json(target);
      let firstParagraphPos = -1;
      let firstParagraphSize = 0;
      target.state.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph' && node.textContent === 'First') {
          firstParagraphPos = pos;
          firstParagraphSize = node.nodeSize;
        }
      });
      expect(firstParagraphPos).toBeGreaterThan(0);
      target.view.dispatch(target.state.tr.delete(firstParagraphPos, firstParagraphPos + firstParagraphSize));
      expect(json(target)).toEqual(before);

      let firstTextEnd = -1;
      target.state.doc.descendants((node, pos) => {
        if (node.isText && node.text === 'First') firstTextEnd = pos + node.nodeSize;
      });
      expect(firstTextEnd).toBeGreaterThan(0);
      target.view.dispatch(target.state.tr.insertText(' edited', firstTextEnd));
      const editedDoc = json(target);
      expect(() => docToMarkdown(editedDoc)).not.toThrow();
      expect(session.execute({ type: 'page.setDoc', id: 'task-page', doc: editedDoc, now: 45 }).ok).toBe(
        true,
      );
      expect(await session.flush()).toBe(true);
      const saved = vault.text(notePath)!;
      expect(saved).toContain('First edited');
      expect(saved).toContain(marker);
      expect(saved.match(/<!-- morrow:block-background:/g)).toHaveLength(1);
      target.destroy();
      editor = null;

      await session.close();
      session = undefined;
      const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'generated-page-again'), {
        delayMs: 0,
      });
      if (!result.ok) throw new Error(result.error);
      reopened = result.value;
      expect(reopened.protectedReasons.has('task-page')).toBe(false);
      const item = reopened.getState().docs['task-page']!.content![0]!.content![0]!;
      expect(item).toMatchObject({
        type: 'taskItem',
        attrs: { backgroundColor: 'blue' },
        content: [{ type: 'paragraph' }, { type: 'paragraph', attrs: { backgroundColor: 'green' } }],
      });
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('colours the whole block rather than its words', () => {
    const target = make({ type: 'doc', content: [p('Shaded')] });
    setBlockBackground(target, [0], 'green');
    const line = json(target).content![0]!;
    expect(line.attrs?.backgroundColor).toBe('green');
    expect(line.content![0]!.marks).toBeUndefined();
    setBlockBackground(target, [0], null);
    expect(json(target).content![0]!.attrs?.backgroundColor ?? null).toBeNull();
  });

  it('renders only normalized HEX block backgrounds into the editor DOM', () => {
    const target = make({
      type: 'doc',
      content: [
        { ...p('Custom'), attrs: { backgroundColor: '#2F80ED' } },
        { ...p('Unsafe'), attrs: { backgroundColor: '#123456; background:url(javascript:alert(1))' } },
      ],
    });
    const html = target.getHTML();
    expect(html).toContain('data-background="#2f80ed"');
    expect(html).toContain('class="block-bg block-bg-custom"');
    expect(html).toContain('style="--block-bg: #2f80ed;"');
    expect(html).toContain('<p>Unsafe</p>');
    expect(html).not.toContain('javascript:');
  });

  it('colours one item of a list on its own', () => {
    const item = (text: string) => ({ type: 'listItem', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [{ type: 'bulletList', content: [item('One'), item('Two')] }],
    });
    setBlockBackground(target, [1], 'red');
    const list = json(target).content![0]!;
    expect(list.attrs?.backgroundColor ?? null).toBeNull();
    expect(list.content![0]!.attrs?.backgroundColor).toBe('red');
    expect(list.content![1]!.attrs?.backgroundColor ?? null).toBeNull();
  });

  it('starts a lettered list from a. and a space', () => {
    const target = make({ type: 'doc', content: [p('')] });
    target.commands.setTextSelection(1);
    type(target, 'a. ');
    expect(json(target).content![0]!.attrs?.type).toBe('a');
  });
});

describe('nested lists', () => {
  const item = (text: string, ...nested: unknown[]) => ({ type: 'listItem', content: [p(text), ...nested] });
  const list = (...items: unknown[]) => ({ type: 'bulletList', content: items });
  const press = (target: Editor, key: string) => {
    const event = new KeyboardEvent('keydown', { key });
    target.view.someProp('handleKeyDown', (handler) => handler(target.view, event));
  };
  const endOf = (target: Editor, text: string) => {
    let at = 0;
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === text) at = pos + node.nodeSize;
    });
    return at;
  };

  // the json without the attributes that are all empty, to compare the shape
  const shape = (node: DocNode): unknown => ({
    type: node.type,
    ...(node.text !== undefined ? { text: node.text } : {}),
    ...(node.content?.length ? { content: node.content.map(shape) } : {}),
  });
  const plain = (doc: unknown) => shape(doc as DocNode);

  it('indents the new line, not the item under it, when tab is pressed between them', () => {
    const target = make({ type: 'doc', content: [list(item('One', list(item('Two'))))] });
    target.commands.setTextSelection(endOf(target, 'One'));
    press(target, 'Enter');
    press(target, 'Tab');
    expect(shape(json(target))).toEqual(
      plain({ type: 'doc', content: [list(item('One', list(item(''), item('Two'))))] }),
    );
    // the cursor stays on the line that moved
    expect(target.state.selection.$from.parent.content.size).toBe(0);
    expect(target.state.selection.$from.depth).toBe(5);
  });

  it('takes the new line away again with backspace or delete, keeping the item under it', () => {
    for (const key of ['Backspace', 'Delete']) {
      const target = make({ type: 'doc', content: [list(item('One', list(item('Two'))))] });
      target.commands.setTextSelection(endOf(target, 'One'));
      press(target, 'Enter');
      press(target, key);
      expect(shape(json(target))).toEqual(
        plain({ type: 'doc', content: [list(item('One', list(item('Two'))))] }),
      );
      target.destroy();
    }
  });
});

describe('home and end', () => {
  it('move to the start and end of the line, and shift selects', () => {
    const target = make({ type: 'doc', content: [p('Hello world'), p('Next')] });
    target.commands.setTextSelection(4);
    const press = (key: string, shiftKey = false, ctrlKey = false) =>
      target.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, ctrlKey, bubbles: true }));
    press('End');
    expect(target.state.selection.head).toBe(12);
    press('Home', true);
    expect(target.state.selection.from).toBe(1);
    expect(target.state.selection.to).toBe(12);
    press('End', false, true);
    expect(target.state.selection.head).toBe(target.state.doc.content.size - 1);
  });
});

describe('the / and @ menus', () => {
  const active = (target: Editor, name: string) => {
    const plugin = target.state.plugins.find((entry) =>
      (entry as unknown as { key: string }).key.startsWith(name),
    );
    return Boolean((plugin?.getState(target.state) as { active?: boolean } | undefined)?.active);
  };

  it('stay away after a space or words that match nothing', () => {
    for (const [char, key] of [
      ['/', 'slashCommand'],
      ['@', 'dateMentionSuggestion'],
    ] as const) {
      const target = make({ type: 'doc', content: [p('')] });
      target.commands.setTextSelection(1);
      type(target, `${char}to`);
      expect(active(target, key)).toBe(true);
      type(target, 'qqzz');
      expect(active(target, key)).toBe(false);
      target.commands.setContent({ type: 'doc', content: [p('')] });
      target.commands.setTextSelection(1);
      type(target, `a ${char} b`);
      expect(active(target, key)).toBe(false);
      // coming back to it later doesn't open it either
      target.commands.setTextSelection(6);
      expect(active(target, key)).toBe(false);
      target.destroy();
    }
  });
});

describe('dates with a time', () => {
  it('reads a time typed after a date', async () => {
    const { typedTime } = await import('./Structure');
    expect(typedTime('today 17:05')).toEqual({ rest: 'today', time: '17:05' });
    expect(typedTime('friday 5pm')).toEqual({ rest: 'friday', time: '17:00' });
    expect(typedTime('next 5')).toBeNull();
    expect(typedTime('today 25:00')).toBeNull();
  });
});

describe('finding words in a folded toggle', () => {
  it('opens the toggle to show the match', async () => {
    const { setFindQuery } = await import('./Blocks');
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: false },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Title' }] },
            { type: 'detailsContent', content: [p('hidden treasure')] },
          ],
        },
      ],
    });
    setFindQuery(target.state, target.view.dispatch, 'treasure');
    expect(json(target).content![0]!.attrs?.open).toBe(true);
  });
});

describe('pasting a list', () => {
  it('fills the empty line it is pasted on rather than going under it', () => {
    const item = (text: string) => ({ type: 'listItem', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [p('Above'), p(''), p('Below'), { type: 'bulletList', content: [item('One'), item('Two')] }],
    });
    const list = target.state.doc.child(3);
    const at =
      target.state.doc.child(0).nodeSize +
      target.state.doc.child(1).nodeSize +
      target.state.doc.child(2).nodeSize;
    // copied from inside the list, the way selecting its items and copying gives it
    const slice = target.state.doc.slice(at + 2, at + list.nodeSize - 2);
    target.commands.setTextSelection(target.state.doc.child(0).nodeSize + 1);
    const handled = target.view.someProp('handlePaste', (handler) =>
      handler(target.view, new Event('paste') as ClipboardEvent, slice),
    );
    if (!handled) target.view.dispatch(target.state.tr.replaceSelection(slice));
    const types = json(target).content!.map((node) => node.type);
    expect(types.slice(0, 3)).toEqual(['paragraph', 'bulletList', 'paragraph']);
    expect(json(target).content![1]!.content![0]!.content![0]!.content![0]!.text).toBe('One');
  });
});

describe('copying from inside a toggle', () => {
  it('pastes the copied line, not a new toggle around it', async () => {
    const { unwrapHolders } = await import('./MarkdownPaste');
    const target = make({
      type: 'doc',
      content: [
        p('Above'),
        {
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Title' }] },
            { type: 'detailsContent', content: [p('Inside one'), p('Inside two')] },
          ],
        },
      ],
    });
    let from = 0;
    let to = 0;
    target.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Inside one') from = pos;
      if (node.isText && node.text === 'Inside two') to = pos + node.nodeSize;
    });
    const slice = unwrapHolders(target.state.doc.slice(from, to));
    expect(slice.content.firstChild!.type.name).toBe('paragraph');
    target.commands.setTextSelection(3);
    target.view.dispatch(target.state.tr.replaceSelection(slice));
    expect(json(target).content!.filter((node) => node.type === 'details')).toHaveLength(1);
  });
});

describe('turning a line into a toggle', () => {
  it('folds the blocks under it into the toggle, stopping at the next heading of any level', () => {
    const heading = (level: number, text: string) => ({
      type: 'heading',
      attrs: { level },
      content: [{ type: 'text', text }],
    });
    const target = make({
      type: 'doc',
      content: [
        heading(2, 'Plans'),
        p('One'),
        heading(3, 'Detail'),
        p('Two'),
        heading(2, 'Next'),
        p('Three'),
      ],
    });
    turnInto(target, 0, { kind: 'toggle', level: 2 });
    const doc = json(target);
    expect(doc.content!.map((node) => node.type)).toEqual([
      'details',
      'heading',
      'paragraph',
      'heading',
      'paragraph',
    ]);
    const inside = doc.content![0]!.content![1]!.content!.map((node) => node.type);
    expect(inside).toEqual(['paragraph']);
    expect(doc.content![0]!.attrs?.open).toBe(false);
  });
});

describe('turning several blocks at once', () => {
  it('turns every selected item of a list into a checklist', async () => {
    const { selectedTextBlocks } = await import('./BlockHandle');
    const { turnBlocks } = await import('./EditorMenus');
    const item = (text: string) => ({ type: 'listItem', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [{ type: 'bulletList', content: [item('One'), item('Two'), item('Three')] }],
    });
    target.commands.setTextSelection({ from: 3, to: target.state.doc.content.size - 3 });
    const range = selectedTextBlocks(target.state)!;
    expect(range).not.toBeNull();
    turnBlocks(target, range, { kind: 'taskList' });
    const doc = json(target);
    expect(doc.content!.map((node) => node.type)).toEqual(['taskList']);
    expect(doc.content![0]!.content).toHaveLength(3);
  });
});

describe('turning several lines at once', () => {
  it('makes one list of them', async () => {
    const { selectedTextBlocks } = await import('./BlockHandle');
    const { turnBlocks } = await import('./EditorMenus');
    const target = make({ type: 'doc', content: [p('One'), p('Two'), p('Three')] });
    target.commands.setTextSelection({ from: 2, to: target.state.doc.content.size - 2 });
    turnBlocks(target, selectedTextBlocks(target.state)!, { kind: 'bulletList' });
    const doc = json(target);
    expect(doc.content!.map((node) => node.type)).toEqual(['bulletList']);
    expect(doc.content![0]!.content).toHaveLength(3);
  });
});

describe('blocks inside columns', () => {
  it('turn on their own, inside a toggle in a column too', () => {
    const item = (text: string) => ({ type: 'listItem', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [
                {
                  type: 'details',
                  attrs: { open: true },
                  content: [
                    { type: 'detailsSummary', content: [{ type: 'text', text: 'Title' }] },
                    {
                      type: 'detailsContent',
                      content: [{ type: 'bulletList', content: [item('Buy milk')] }],
                    },
                  ],
                },
              ],
            },
            { type: 'column', content: [p('Right')] },
          ],
        },
      ],
    });
    let at = 0;
    target.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem') at = pos;
    });
    turnInto(target, at, { kind: 'taskList' });
    const toggle = json(target).content![0]!.content![0]!.content![0]!;
    expect(toggle.type).toBe('details');
    expect(toggle.content![1]!.content![0]!.type).toBe('taskList');
  });
});

describe('dragging a block by its handle', () => {
  it('moves the block to where the pointer lets go', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const target = new Editor({
      element: host,
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
      content: { type: 'doc', content: [p('One'), p('Two'), p('Three')] } as never,
    });
    editor = target;
    // the page has no layout here, every block sits at the top, so the pointer is over the first
    target.view.dom.parentElement!.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }),
    );
    const end = target.state.doc.content.size;
    target.view.posAtCoords = () => ({ pos: end, inside: -1 });
    const handle = host.querySelector<HTMLElement>('.block-handle')!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, clientX: 0, clientY: 0, bubbles: true }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40, clientY: 40, bubbles: true }));
    expect(document.querySelector('.block-drag-ghost')?.textContent).toBe('One');
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: 40, clientY: 40, bubbles: true }));
    expect(json(target).content!.map((node) => node.content![0]!.text)).toEqual(['Two', 'Three', 'One']);
    expect(document.querySelector('.block-drag-ghost')).toBeNull();
    host.remove();
  });
});

describe('pasting words and pictures from another app', () => {
  it('keeps a picture word or libreoffice put on the clipboard as a file', async () => {
    const { DOMParser: PmParser } = await import('@tiptap/pm/model');
    const target = make({ type: 'doc', content: [p('')] });
    const html = new window.DOMParser().parseFromString(
      '<p>Before</p><img src="file:///C:/Users/me/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png"><p>After</p>',
      'text/html',
    );
    const doc = PmParser.fromSchema(target.schema).parse(html.body);
    const types: string[] = [];
    doc.forEach((node) => types.push(node.type.name));
    expect(types).toEqual(['paragraph', 'image', 'paragraph']);
    expect(String(doc.child(1).attrs.src)).toMatch(/^file:\/\/\//);
  });
});

describe('picking words in several places', () => {
  it('copies every piece kept with ctrl, in page order', async () => {
    const { allPieces, keepPiece, piecesForClipboard } = await import('./MultiSelect');
    const target = make({ type: 'doc', content: [p('Alpha beta'), p('Gamma delta'), p('Epsilon')] });
    // "beta" picked first, then "Epsilon" with ctrl held
    target.view.dispatch(keepPiece(target.state.tr, { from: 7, to: 11 }, target.state));
    const end = target.state.doc.content.size - 1;
    target.commands.setTextSelection({ from: end - 7, to: end });
    const pieces = allPieces(target.state);
    expect(pieces).toHaveLength(2);
    expect(piecesForClipboard(target.view, pieces).text).toBe('beta\nEpsilon');
    // an edit lets the kept pieces go
    target.commands.insertContent('!');
    expect(allPieces(target.state)).toHaveLength(0);
  });
});

describe('columns', () => {
  it('move a column to another place among the others', async () => {
    const { moveColumn } = await import('./ColumnGrip');
    const column = (text: string) => ({ type: 'column', content: [p(text)] });
    const target = make({
      type: 'doc',
      content: [{ type: 'columns', content: [column('A'), column('B'), column('C')] }],
    });
    // a position inside the first column
    moveColumn(target.state, target.view.dispatch, 2, 2);
    const texts = json(target).content![0]!.content!.map((item) => item.content![0]!.content![0]!.text);
    expect(texts).toEqual(['B', 'C', 'A']);
  });
});

describe('html blocks', () => {
  it('draw their page in a frame that runs no scripts once the preview is on', async () => {
    const code = (preview: boolean | null) => ({
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'html', preview },
          content: [{ type: 'text', text: '<b>Hi</b><script>parent.hacked = 1</script>' }],
        },
      ],
    });
    const plain = make(code(null));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(plain.view.dom.querySelector('iframe')).toBeNull();
    plain.destroy();
    const target = make(code(true));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frame = target.view.dom.querySelector('iframe')!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.srcdoc).toContain('<b>Hi</b>');
    expect(target.view.dom.querySelector('.code-block')!.classList.contains('hide-code')).toBe(true);
    // turning it off brings the code back and takes the frame away
    target.view.dispatch(target.state.tr.setNodeMarkup(0, undefined, { language: 'html', preview: null }));
    expect(target.view.dom.querySelector('.code-block')!.classList.contains('hide-code')).toBe(false);
    expect(target.view.dom.querySelector('iframe')).toBeNull();
  });
});
