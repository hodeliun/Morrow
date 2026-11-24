// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { describe, expect, it } from 'vitest';
import type { DocNode } from '../core/model';
import { markdownToDoc } from '../core/markdown/parse';
import { docToMarkdown } from '../core/markdown/serialize';
import { findUnrepresentablePageContent } from '../core/vault/compatibility';
import { readPageText } from '../core/vault/pageFile';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';
import { createExtensions } from '../app/editor/extensions';

const NOTE_ID = 'seven-column-note';
const NOTE_PATH = 'Seven columns.md';

function markdownColumnLayout(count: number, emptyIndex = -1, widths?: string): string {
  const columns = Array.from({ length: count }, (_, index) => {
    const body =
      index === emptyIndex
        ? ''
        : index === 0
          ? `**Column ${index + 1}** ^column-${index + 1}`
          : `Column ${index + 1} ^column-${index + 1}`;
    return `<div data-column>\n\n${body}\n\n</div>`;
  });
  const widthAttribute = widths === undefined ? '' : ` data-widths="${widths}"`;
  return `Before ^before\n\n<div data-columns${widthAttribute}>\n${columns.join('\n')}\n</div>\n\nAfter ^after\n`;
}

function makeEditor(content: unknown): Editor {
  return new Editor({
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
}

function textEnd(editor: Editor, text: string): number {
  let result: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text?.includes(text)) {
      result = pos + node.text.indexOf(text) + text.length;
      return false;
    }
    return true;
  });
  if (result === null) throw new Error(`Could not find text: ${text}`);
  return result;
}

type VaultOperations = Parameters<MemoryVault['apply']>[0];

class ObservedMemoryVault extends MemoryVault {
  readonly applyCalls: VaultOperations[] = [];

  override async apply(operations: VaultOperations) {
    this.applyCalls.push(operations);
    return super.apply(operations);
  }
}

function registryFor(path: string): string {
  return JSON.stringify({ version: 1, pages: { [path]: { id: NOTE_ID, order: 0 } } });
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-new-id'), {
    delayMs: 0,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe('published equal-width column layouts', () => {
  it('checks two through seven columns in the real editor schema and repairs valid empty columns', () => {
    for (let count = 2; count <= 7; count++) {
      const imported = markdownToDoc(markdownColumnLayout(count, count - 1));
      const editor = makeEditor(imported);
      try {
        expect(() => editor.state.doc.check(), `column count ${count}`).not.toThrow();
        const columns = editor.state.doc.child(1);
        expect(columns.type.name).toBe('columns');
        expect(columns.childCount).toBe(count);
        expect(columns.child(count - 1).childCount).toBe(1);
        expect(columns.child(count - 1).firstChild?.type.name).toBe('paragraph');
      } finally {
        editor.destroy();
      }
    }
  });

  it('keeps rich block structure in representable two-to-five-column groups', () => {
    const content = [
      '**Bold** with [a link](https://example.org) ^rich-one',
      '- First item\n- Second item',
      '> A quoted block',
      '# A heading',
      'A paragraph with *emphasis* ^rich-five',
    ];
    for (let count = 2; count <= 5; count++) {
      const wrappers = content
        .slice(0, count)
        .map((body) => `<div data-column>\n\n${body}\n\n</div>`)
        .join('\n');
      const source = `<div data-columns>\n${wrappers}\n</div>\n`;
      const editor = makeEditor(markdownToDoc(source));
      try {
        editor.state.doc.check();
        const columns = editor.state.doc.firstChild!;
        expect(columns.childCount).toBe(count);
        expect(
          Array.from({ length: count }, (_, index) => columns.child(index).firstChild?.type.name),
        ).toEqual(['paragraph', 'bulletList', 'blockquote', 'heading', 'paragraph'].slice(0, count));
        const roundTrip = markdownToDoc(docToMarkdown(editor.getJSON() as DocNode));
        const roundTripEditor = makeEditor(roundTrip);
        try {
          roundTripEditor.state.doc.check();
          expect(roundTripEditor.state.doc.firstChild?.childCount).toBe(count);
        } finally {
          roundTripEditor.destroy();
        }
      } finally {
        editor.destroy();
      }
    }
  });

  it('edits and reopens a layout containing a preserved opaque HTML block', async () => {
    const opaque = '<div class="ordinary">\nOpaque raw content\n</div>';
    const source = `---\ntitle: Seven columns\ntags:\n  - fixture\ncustom:\n  keep: true\n---\nBefore ^before\n\n<div data-columns>\n<div data-column>\n\nFirst column before ^inside-before\n\n${opaque}\n\nFirst column after ^inside-after\n\n</div>\n<div data-column>\n\nSecond column ^second\n\n</div>\n</div>\n\nAfter ^after\n`;
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const vault = new ObservedMemoryVault({
      [NOTE_PATH]: source,
      '.morrow/workspace.json': registryFor(NOTE_PATH),
      '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
    });
    let session = await open(vault);
    let editor: Editor | null = null;
    try {
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
      editor = makeEditor(session.getState().docs[NOTE_ID]);
      editor.state.doc.check();
      const firstColumn = editor.state.doc.child(1).child(0);
      expect(firstColumn.content.content.some((node) => node.type.name === 'rawBlock')).toBe(true);
      editor.view.dispatch(editor.state.tr.insertText(' edited', textEnd(editor, 'After')));
      editor.state.doc.check();

      const updated = session.execute({
        type: 'page.setDoc',
        id: NOTE_ID,
        doc: editor.getJSON() as DocNode,
        now: 3,
      });
      if (!updated.ok) throw new Error(updated.error);
      expect(await session.flush()).toBe(true);
    } finally {
      editor?.destroy();
      await session.close();
    }

    const saved = vault.text(NOTE_PATH)!;
    expect(saved).toContain('custom:\n  keep: true');
    expect(saved).toContain(opaque);
    expect(saved).toContain('After edited ^after');
    expect((saved.match(/<div data-column>/g) ?? []).length).toBe(2);
    expect(saved).toContain('^inside-before');
    expect(saved).toContain('^inside-after');

    session = await open(vault);
    try {
      const reopened = session.getState().docs[NOTE_ID]!;
      const columns = reopened.content?.find((node) => node.type === 'columns');
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
      expect(columns?.content).toHaveLength(2);
      expect(columns?.content?.[0]?.content?.some((node) => node.type === 'rawBlock' && node.attrs?.text === opaque)).toBe(
        true,
      );
      expect(reopened.content?.at(-1)?.attrs?.blockId).toBe('after');
      expect(docToMarkdown(reopened)).toContain(opaque);
    } finally {
      await session.close();
    }
  });

  it('round-trips nested ordinary div trees as opaque blocks in the real editor', () => {
    const opaqueForms = [
      '<div class="outer">\n<div class="inner">Opaque raw content</div>\n</div>',
      '<div class="outer"><div class="inner">Opaque raw content</div></div>',
      '<div class="one">One</div>\n<div class="two">Two</div>',
      '<div id="notice" aria-label="Info">Raw note</div>',
      '<div id="notice" aria-label="Info">Raw <strong>note</strong></div>',
      '<div class="outer">\n<!-- keep this -->\n<div class="inner">Opaque raw content</div>\n</div>',
    ];
    for (const opaque of opaqueForms) {
      const source = `<div data-columns>\n<div data-column>\n\n${opaque}\n\n</div>\n<div data-column>\n\nSecond column\n\n</div>\n</div>`;
      expect(findUnrepresentablePageContent(source)).toBeNull();

      const editor = makeEditor(markdownToDoc(source));
      try {
        editor.state.doc.check();
        const rawBlock = editor.state.doc.child(0).child(0).child(0);
        expect(rawBlock.type.name).toBe('rawBlock');
        expect(rawBlock.attrs.text).toBe(opaque);

        const serialized = docToMarkdown(editor.getJSON() as DocNode);
        expect(serialized).toContain(opaque);
        const reopened = makeEditor(markdownToDoc(serialized));
        try {
          reopened.state.doc.check();
          expect(reopened.state.doc.child(0).child(0).child(0).attrs.text).toBe(opaque);
        } finally {
          reopened.destroy();
        }
      } finally {
        editor.destroy();
      }
    }
  });

  it('edits a column and its neighboring block with real editor history', () => {
    const editor = makeEditor(markdownToDoc(markdownColumnLayout(7, 6)));
    try {
      editor.state.doc.check();
      editor.view.dispatch(editor.state.tr.insertText(' changed', textEnd(editor, 'Column 1')));
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.view.dispatch(editor.state.tr.insertText(' neighbor', textEnd(editor, 'After')));
      editor.state.doc.check();
      expect(editor.state.doc.textContent).toContain('Column 1 changed');
      expect(editor.state.doc.textContent).toContain('After neighbor');

      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.textContent).toContain('Column 1 changed');
      expect(editor.state.doc.textContent).not.toContain('After neighbor');
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.textContent).not.toContain('Column 1 changed');

      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.textContent).toContain('Column 1 changed');
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.textContent).toContain('After neighbor');
      editor.state.doc.check();
    } finally {
      editor.destroy();
    }
  });

  it('keeps a rejected group byte-for-byte untouched when the loader opens it', async () => {
    const source = `---\ntitle: Protected layout\ncustom: keep-me\n---\n${markdownColumnLayout(8)}`;
    const vault = new ObservedMemoryVault({
      'Protected layout.md': source,
      '.morrow/workspace.json': registryFor('Protected layout.md'),
      '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
    });
    const beforeMtime = vault.modifiedTime('Protected layout.md');
    const session = await open(vault);
    try {
      expect(session.protectedReasons.has(NOTE_ID)).toBe(true);
      expect(session.getState().docs[NOTE_ID]).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(vault.applyCalls).toHaveLength(0);
      expect(vault.text('Protected layout.md')).toBe(source);
      expect(vault.modifiedTime('Protected layout.md')).toBe(beforeMtime);
    } finally {
      await session.close();
    }
    expect(vault.applyCalls).toHaveLength(0);
    expect(vault.text('Protected layout.md')).toBe(source);
  });

  it('saves and reopens a seven-column session with order, YAML, formatting, and block IDs intact', async () => {
    const body = markdownColumnLayout(7, 6);
    const source = `---\ntitle: Seven columns\ntags:\n  - fixture\ncustom:\n  keep: true\n---\n${body}`;
    const vault = new ObservedMemoryVault({
      [NOTE_PATH]: source,
      '.morrow/workspace.json': registryFor(NOTE_PATH),
      '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
    });
    let session = await open(vault);
    let editor: Editor | null = null;
    try {
      expect(vault.applyCalls).toHaveLength(0);
      editor = makeEditor(session.getState().docs[NOTE_ID]);
      editor.state.doc.check();
      editor.view.dispatch(editor.state.tr.insertText(' changed', textEnd(editor, 'Column 1')));
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.view.dispatch(editor.state.tr.insertText(' neighbor', textEnd(editor, 'After')));
      editor.state.doc.check();

      const updated = session.execute({
        type: 'page.setDoc',
        id: NOTE_ID,
        doc: editor.getJSON() as DocNode,
        now: 2,
      });
      if (!updated.ok) throw new Error(updated.error);
      expect(await session.flush()).toBe(true);
      const saved = vault.text(NOTE_PATH)!;
      expect(saved).toContain('custom:\n  keep: true');
      expect(saved).toContain('**Column 1 changed**');
      expect(saved).toContain('After neighbor ^after');
      expect((saved.match(/<div data-column>/g) ?? []).length).toBe(7);
      expect(saved).toContain('^column-1');
      expect(saved).toContain('^before');
      expect(vault.applyCalls.length).toBeGreaterThan(0);
    } finally {
      editor?.destroy();
      await session.close();
    }

    session = await open(vault);
    try {
      const reopened = session.getState().docs[NOTE_ID]!;
      const group = reopened.content?.find((node) => node.type === 'columns');
      expect(group?.content).toHaveLength(7);
      expect(
        group?.content?.map((column) =>
          column.content?.map((node) => node.content?.map((text) => text.text ?? '').join('')).join(''),
        ),
      ).toEqual(['Column 1 changed', 'Column 2', 'Column 3', 'Column 4', 'Column 5', 'Column 6', '']);
      expect(group?.content?.[0]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }]);
      expect(group?.content?.[0]?.content?.[0]?.attrs?.blockId).toBe('column-1');
      expect(group?.content?.[6]?.content?.[0]?.type).toBe('paragraph');
      expect(reopened.content?.[0]?.attrs?.blockId).toBe('before');
      expect(reopened.content?.at(-1)?.attrs?.blockId).toBe('after');
      expect(
        reopened.content
          ?.at(-1)
          ?.content?.map((node) => node.text ?? '')
          .join(''),
      ).toBe('After neighbor');

      const metadata = readPageText(vault.text(NOTE_PATH)!);
      expect(metadata.tags).toEqual(['fixture']);
      expect(metadata.extra.custom).toEqual({ keep: true });
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('edits, serializes, and reopens legacy weighted groups without normalizing their spelling', async () => {
    const examples = [
      { widths: '14.1,14.1,14.1,14.1,14.1,14.7,14.8', count: 7 },
      { widths: '020.00, 080.00', count: 2 },
      { widths: '\t020.00,\t080.00\t', count: 2 },
      { widths: '50.05,49.95', count: 2 },
    ];

    for (const [index, { widths, count }] of examples.entries()) {
      const path = `Weighted ${index + 1}.md`;
      const body = markdownColumnLayout(count, count - 1, widths);
      const source = `---\ntitle: Weighted ${index + 1}\ntags:\n  - fixture\ncustom:\n  keep: true\n---\n${body}`;
      expect(findUnrepresentablePageContent(source), widths).toBeNull();

      const vault = new ObservedMemoryVault({
        [path]: source,
        '.morrow/workspace.json': registryFor(path),
        '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
      });
      let session = await open(vault);
      let editor: Editor | null = null;
      try {
        expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
        expect(vault.applyCalls).toHaveLength(0);
        editor = makeEditor(session.getState().docs[NOTE_ID]);
        editor.state.doc.check();
        const group = editor.state.doc.child(1);
        expect(group.type.name).toBe('columns');
        expect(group.childCount).toBe(count);
        expect(group.attrs.widths).toBe(widths);
        const renderedGroup = editor.view.dom.querySelector('.columns') as HTMLElement;
        expect(renderedGroup.getAttribute('data-widths')).toBe(widths);
        expect(renderedGroup.style.getPropertyValue('--column-grid-template')).toContain('fr');

        editor.view.dispatch(editor.state.tr.insertText(' changed', textEnd(editor, 'Column 1')));
        editor.view.dispatch(closeHistory(editor.state.tr));
        editor.view.dispatch(editor.state.tr.insertText(' neighbor', textEnd(editor, 'After')));
        expect(editor.commands.undo()).toBe(true);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.commands.redo()).toBe(true);
        expect(editor.commands.redo()).toBe(true);
        editor.state.doc.check();

        const savedDoc = editor.getJSON() as DocNode;
        expect(savedDoc.content?.[1]?.attrs?.widths).toBe(widths);
        const updated = session.execute({ type: 'page.setDoc', id: NOTE_ID, doc: savedDoc, now: index + 2 });
        if (!updated.ok) throw new Error(updated.error);
        expect(await session.flush()).toBe(true);
      } finally {
        editor?.destroy();
        await session.close();
      }

      const saved = vault.text(path)!;
      expect(saved).toContain(`<div data-columns data-widths="${widths}">`);
      expect(saved).toContain('**Column 1 changed**');
      expect(saved).toContain('After neighbor ^after');
      expect(saved).toContain('custom:\n  keep: true');
      expect((saved.match(/<div data-column>/g) ?? []).length).toBe(count);

      session = await open(vault);
      try {
        const reopened = session.getState().docs[NOTE_ID]!;
        expect(reopened.content?.[1]?.attrs?.widths).toBe(widths);
        expect(reopened.content?.[0]?.attrs?.blockId).toBe('before');
        expect(reopened.content?.at(-1)?.attrs?.blockId).toBe('after');
        expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
        expect(readPageText(vault.text(path)!).extra.custom).toEqual({ keep: true });
      } finally {
        await session.close();
      }
    }
  });

  it('edits a weighted group with a legacy HEX background and protects a mismatched weighted group', async () => {
    const widths = '020.00, 080.00';
    const path = 'Weighted background.md';
    const source = [
      '---',
      'title: Weighted background',
      'tags:',
      '  - fixture',
      'custom:',
      '  keep: true',
      '---',
      'Before ^before',
      '',
      `<div data-columns data-widths="${widths}">`,
      '<div data-column>',
      '',
      '<!-- morrow:block-background:#1a2b3c -->',
      '',
      'First ^first',
      '',
      '</div>',
      '<div data-column>',
      '',
      'Second ^second',
      '',
      '</div>',
      '</div>',
      '',
      'After ^after',
      '',
    ].join('\n');
    expect(findUnrepresentablePageContent(source)).toBeNull();

    const vault = new ObservedMemoryVault({
      [path]: source,
      '.morrow/workspace.json': registryFor(path),
      '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
    });
    let session = await open(vault);
    let editor: Editor | null = null;
    try {
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
      expect(vault.applyCalls).toHaveLength(0);
      editor = makeEditor(session.getState().docs[NOTE_ID]);
      editor.state.doc.check();
      const group = editor.state.doc.child(1);
      expect(group.type.name).toBe('columns');
      expect(group.attrs.widths).toBe(widths);

      const coloredParagraphs: Array<{ attrs: { backgroundColor?: string; blockId?: string } }> = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'paragraph' && node.textContent.includes('First')) {
          coloredParagraphs.push(node as unknown as { attrs: { backgroundColor?: string; blockId?: string } });
        }
      });
      expect(coloredParagraphs[0]?.attrs.backgroundColor).toBe('#1a2b3c');
      expect(coloredParagraphs[0]?.attrs.blockId).toBe('first');

      editor.view.dispatch(editor.state.tr.insertText(' neighbor', textEnd(editor, 'After')));
      editor.state.doc.check();
      const updated = session.execute({
        type: 'page.setDoc',
        id: NOTE_ID,
        doc: editor.getJSON() as DocNode,
        now: 5,
      });
      if (!updated.ok) throw new Error(updated.error);
      expect(await session.flush()).toBe(true);
    } finally {
      editor?.destroy();
      await session.close();
    }

    const saved = vault.text(path)!;
    expect(saved).toContain(`<div data-columns data-widths="${widths}">`);
    expect(saved).toContain('<!-- morrow:block-background:#1a2b3c -->');
    expect(saved).toContain('After neighbor ^after');
    expect(saved).toContain('custom:\n  keep: true');
    expect(JSON.parse(vault.text('.morrow/workspace.json')!).pages[path].order).toBe(0);

    session = await open(vault);
    try {
      expect(session.protectedReasons.has(NOTE_ID)).toBe(false);
      const reopened = session.getState().docs[NOTE_ID]!;
      expect(reopened.content?.[1]?.attrs?.widths).toBe(widths);
      expect(reopened.content?.[0]?.attrs?.blockId).toBe('before');
      expect(reopened.content?.at(-1)?.attrs?.blockId).toBe('after');
      const findColoredParagraph = (node: DocNode): DocNode | null => {
        if (node.type === 'paragraph' && node.content?.some((child) => child.text?.includes('First'))) return node;
        for (const child of node.content ?? []) {
          const found = findColoredParagraph(child);
          if (found) return found;
        }
        return null;
      };
      const reopenedParagraph = findColoredParagraph(reopened);
      expect(reopenedParagraph?.attrs?.backgroundColor).toBe('#1a2b3c');
      expect(reopenedParagraph?.attrs?.blockId).toBe('first');
      expect(readPageText(vault.text(path)!).extra.custom).toEqual({ keep: true });
      expect(readPageText(vault.text(path)!).tags).toEqual(['fixture']);
    } finally {
      await session.close();
    }

    const invalidPath = 'Weighted background invalid.md';
    const invalidSource = source.replace(`data-widths="${widths}"`, 'data-widths="20,30,50"');
    const invalidVault = new ObservedMemoryVault({
      [invalidPath]: invalidSource,
      '.morrow/workspace.json': registryFor(invalidPath),
      '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
    });
    const protectedSession = await open(invalidVault);
    try {
      expect(protectedSession.protectedReasons.has(NOTE_ID)).toBe(true);
      expect(protectedSession.getState().docs[NOTE_ID]).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: invalidSource } }],
      });
      expect(invalidVault.text(invalidPath)).toBe(invalidSource);
      expect(invalidVault.applyCalls).toHaveLength(0);
    } finally {
      await protectedSession.close();
    }
  });

  it('resets equal-width CSS tracks inside a weighted group', () => {
    const nestedColumns = (first: string, second: string) => ({
      type: 'columns',
      content: [
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: first }] }] },
        { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: second }] }] },
      ],
    });
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'columns',
          attrs: { widths: '50.05,49.95' },
          content: [
            {
              type: 'column',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Outer one' }] },
                nestedColumns('Inner one', 'Inner two'),
              ],
            },
            { type: 'column', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Outer two' }] }] },
          ],
        },
      ],
    });
    try {
      editor.state.doc.check();
      const groups = Array.from(editor.view.dom.querySelectorAll('.columns')) as HTMLElement[];
      expect(groups).toHaveLength(2);
      expect(groups[0]!.style.getPropertyValue('--column-grid-template')).toBe(
        'minmax(0, 50.05fr) minmax(0, 49.95fr)',
      );
      expect(groups[1]!.style.getPropertyValue('--column-grid-template')).toBe(
        'repeat(2, minmax(0, 1fr))',
      );
    } finally {
      editor.destroy();
    }
  });
});
