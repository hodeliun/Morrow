import { Fragment, Schema } from '@tiptap/pm/model';
import { history, undo } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import {
  isTableToggle,
  setHeadingCollapsible,
  unwrapDetailsToParagraph,
  wrapBlockInDetails,
} from './CollapsibleHeading';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      attrs: { blockId: { default: null }, blockBackground: { default: null } },
    },
    heading: {
      content: 'inline*',
      group: 'block',
      attrs: {
        level: { default: 1 },
        collapsible: { default: false },
        collapsed: { default: false },
        blockBackground: { default: null },
      },
    },
    details: {
      content: 'detailsSummary detailsContent',
      group: 'block',
      attrs: {
        open: { default: false },
        blockId: { default: null },
        tableToggleTitle: { default: null },
      },
    },
    detailsSummary: {
      content: 'inline*',
      attrs: { blockBackground: { default: null } },
    },
    detailsContent: { content: 'block*' },
    table: {
      content: 'tableRow+',
      group: 'block',
      attrs: { tableId: { default: null } },
    },
    tableRow: { content: '(tableHeader|tableCell)+' },
    tableHeader: { content: 'block+' },
    tableCell: { content: 'block+' },
    linkedDatabaseView: {
      group: 'block',
      atom: true,
      attrs: { blockId: { default: null }, view: { default: null } },
    },
    text: { group: 'inline' },
  },
  marks: {
    bold: {},
    italic: {},
    link: { attrs: { href: {} } },
    code: {},
    underline: {},
    highlight: { attrs: { color: { default: null } } },
    textColor: { attrs: { color: { default: null } } },
  },
});

function undoOnce(state: EditorState): EditorState {
  let next = state;
  expect(undo(state, (tr) => (next = next.apply(tr)))).toBe(true);
  return next;
}

describe('reversible collapsible conversions', () => {
  it('keeps heading level, marks, children and IDs when enabling section folding', () => {
    const heading = schema.node('heading', { level: 3, collapsible: false }, [
      schema.text('Marked ', [schema.mark('bold')]),
      schema.text('heading'),
    ]);
    const child = schema.node('paragraph', { blockId: 'child-block' }, [schema.text('Child')]);
    const linked = schema.node('linkedDatabaseView', {
      blockId: 'linked-view-block',
      view: { id: 'linked-view-id', collapsed: true },
    });
    const doc = schema.node('doc', null, [heading, child, linked]);
    const state = EditorState.create({ schema, doc, plugins: [history()] });
    const tr = state.tr;

    expect(setHeadingCollapsible(tr, 0, true)).toBe(true);
    const folded = tr.doc;
    expect(folded.child(0).type.name).toBe('heading');
    expect(folded.child(0).attrs).toMatchObject({ level: 3, collapsible: true, collapsed: false });
    expect(folded.child(0).content.eq(heading.content)).toBe(true);
    expect(folded.child(1).eq(child)).toBe(true);
    expect(folded.child(2).eq(linked)).toBe(true);
    expect(undoOnce(state.apply(tr)).doc.eq(doc)).toBe(true);
  });

  it('round trips ordinary marked text through details without turning it into a heading', () => {
    const paragraph = schema.node(
      'paragraph',
      { blockId: 'paragraph-block', blockBackground: '#345678' },
      [
        schema.text('keep '),
        schema.text('bold', [schema.mark('bold')]),
        schema.text(' '),
        schema.text('italic', [schema.mark('italic')]),
        schema.text(' '),
        schema.text('linked', [schema.mark('link', { href: 'https://example.test/path?a=1&b=2&amp;literal' })]),
        schema.text(' '),
        schema.text('code', [schema.mark('code')]),
        schema.text(' '),
        schema.text('underline', [schema.mark('underline')]),
        schema.text(' '),
        schema.text('highlight', [schema.mark('highlight', { color: '#123456' })]),
        schema.text(' '),
        schema.text('colored', [schema.mark('textColor', { color: '#654321' })]),
        schema.text(' literal &lt;u&gt; & &amp; <u>'),
      ],
    );
    const doc = schema.node('doc', null, [paragraph]);
    const state = EditorState.create({ schema, doc, plugins: [history()] });
    const tr = state.tr;
    const placeholder = schema.nodes.paragraph!.create();

    expect(
      wrapBlockInDetails(
        tr,
        0,
        paragraph.content,
        Fragment.from(placeholder),
        { blockBackground: paragraph.attrs.blockBackground },
      ),
    ).toBe(true);
    const details = tr.doc.child(0);
    expect(details.type.name).toBe('details');
    expect(details.child(0).type.name).toBe('detailsSummary');
    expect(details.child(0).content.eq(paragraph.content)).toBe(true);
    expect(details.child(0).attrs.blockBackground).toBe('#345678');
    expect(details.attrs.blockId).toBe('paragraph-block');
    expect(details.child(1).firstChild?.attrs.blockId).toBeNull();
    expect(undoOnce(state.apply(tr)).doc.eq(doc)).toBe(true);

    const saved = docToMarkdown(tr.doc.toJSON());
    expect(saved).toContain('data-block-id="paragraph-block"');
    expect(saved).toContain('data-block-background="#345678"');
    expect(saved).toContain('data-morrow-summary-format="markdown"');
    const reopened = markdownToDoc(saved);
    expect(reopened.content?.[0]?.attrs).toMatchObject({ open: true, blockId: 'paragraph-block' });
    expect(reopened.content?.[0]?.content?.[0]?.attrs?.blockBackground).toBe('#345678');
    expect(reopened.content?.[0]?.content?.[0]?.content).toEqual(paragraph.content.toJSON());
    const reopenedDoc = schema.nodeFromJSON(reopened);
    const wrappedState = EditorState.create({ schema, doc: reopenedDoc, plugins: [history()] });
    const remove = wrappedState.tr;
    expect(unwrapDetailsToParagraph(remove, 0)).toBe(true);
    expect(remove.doc.eq(doc)).toBe(true);
    expect(undoOnce(wrappedState.apply(remove)).doc.eq(reopenedDoc)).toBe(true);
  });

  it('wraps and unwraps an inline table without replacing its table or linked-view IDs', () => {
    const linked = schema.node('linkedDatabaseView', {
      blockId: 'nested-linked-view-block',
      view: { id: 'nested-view-id', collapsed: false },
    });
    const table = schema.node('table', { tableId: 'inline-table-id' }, [
      schema.node('tableRow', null, [
        schema.node('tableCell', null, [schema.node('paragraph', null, [schema.text('Cell')]), linked]),
      ]),
    ]);
    const doc = schema.node('doc', null, [table]);
    const state = EditorState.create({ schema, doc, plugins: [history()] });
    const tr = state.tr;
    const label = schema.text('Table');

    expect(
      wrapBlockInDetails(tr, 0, Fragment.from(label), Fragment.from(table), {}, { tableToggleTitle: 'Table' }),
    ).toBe(true);
    const wrapped = tr.doc.child(0);
    expect(wrapped.child(0).textContent).toBe('Table');
    expect(wrapped.attrs.tableToggleTitle).toBe('Table');
    expect(isTableToggle(wrapped)).toBe(true);
    expect(wrapped.child(1).firstChild?.eq(table)).toBe(true);
    expect(wrapped.child(1).firstChild?.attrs.tableId).toBe('inline-table-id');
    let preservedLinkedId: unknown;
    wrapped.child(1).firstChild?.descendants((node) => {
      if (node.type.name === 'linkedDatabaseView') preservedLinkedId = node.attrs.blockId;
    });
    expect(preservedLinkedId).toBe('nested-linked-view-block');
    expect(undoOnce(state.apply(tr)).doc.eq(doc)).toBe(true);

    const wrappedState = EditorState.create({ schema, doc: tr.doc, plugins: [history()] });
    const remove = wrappedState.tr;
    expect(unwrapDetailsToParagraph(remove, 0)).toBe(true);
    expect(remove.doc.childCount).toBe(1);
    expect(remove.doc.child(0).eq(table)).toBe(true);
    expect(undoOnce(wrappedState.apply(remove)).doc.eq(tr.doc)).toBe(true);
  });

  it('restores a marked table toggle after Markdown reopen even when the UI locale changes', () => {
    const table = schema.node('table', null, [
      schema.node('tableRow', null, [
        schema.node('tableHeader', null, [schema.node('paragraph', null, [schema.text('Heading')])]),
      ]),
      schema.node('tableRow', null, [
        schema.node('tableCell', null, [schema.node('paragraph', null, [schema.text('Cell')])]),
      ]),
    ]);
    const original = schema.node('doc', null, [table]);
    const state = EditorState.create({ schema, doc: original, plugins: [history()] });
    const tr = state.tr;
    expect(
      wrapBlockInDetails(
        tr,
        0,
        Fragment.from(schema.text('Tabla')),
        Fragment.from(table),
        {},
        { tableToggleTitle: 'Tabla' },
      ),
    ).toBe(true);

    const markdown = docToMarkdown(tr.doc.toJSON());
    expect(markdown).toContain('data-morrow-table-toggle="Tabla"');
    const reopenedJson = markdownToDoc(markdown);
    expect(reopenedJson.content?.[0]?.attrs?.tableToggleTitle).toBe('Tabla');
    const reopenedDoc = schema.nodeFromJSON(reopenedJson);
    const reopenedState = EditorState.create({ schema, doc: reopenedDoc, plugins: [history()] });
    const remove = reopenedState.tr;
    expect(isTableToggle(remove.doc.child(0))).toBe(true);
    expect(unwrapDetailsToParagraph(remove, 0)).toBe(true);
    expect(remove.doc.eq(original)).toBe(true);
    expect(undoOnce(reopenedState.apply(remove)).doc.eq(reopenedDoc)).toBe(true);
  });

  it('preserves legacy or edited table summaries when removing collapse', () => {
    const table = schema.node('table', null, [
      schema.node('tableRow', null, [
        schema.node('tableCell', null, [schema.node('paragraph', null, [schema.text('Cell')])]),
      ]),
    ]);
    const summary = (text: string) => schema.node('detailsSummary', null, [schema.text(text)]);
    const content = schema.node('detailsContent', null, [table]);
    const legacy = schema.node('details', { open: true }, [summary('Table'), content]);
    const edited = schema.node('details', { open: true, tableToggleTitle: 'Table' }, [summary('Edited title'), content]);

    expect(isTableToggle(legacy)).toBe(false);
    const legacyTransaction = EditorState.create({ schema, doc: schema.node('doc', null, [legacy]) }).tr;
    expect(unwrapDetailsToParagraph(legacyTransaction, 0)).toBe(true);
    expect(legacyTransaction.doc.childCount).toBe(2);
    expect(legacyTransaction.doc.child(0).textContent).toBe('Table');
    expect(legacyTransaction.doc.child(1).eq(table)).toBe(true);

    expect(isTableToggle(edited)).toBe(true);
    const editedTransaction = EditorState.create({ schema, doc: schema.node('doc', null, [edited]) }).tr;
    expect(unwrapDetailsToParagraph(editedTransaction, 0)).toBe(true);
    expect(editedTransaction.doc.childCount).toBe(2);
    expect(editedTransaction.doc.child(0).textContent).toBe('Edited title');
    expect(editedTransaction.doc.child(1).eq(table)).toBe(true);
  });
});
