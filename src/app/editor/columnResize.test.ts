import { describe, expect, it } from 'vitest';
import { undo, history } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { normalizeColumnWidths, resizeColumnWidths } from '../../core/model';
import {
  closeColumnResizeHistory,
  createColumnWidthsTransaction,
  shouldCommitColumnWidthResize,
} from './columnResize';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    heading: {
      group: 'block',
      content: 'text*',
      attrs: { level: { default: 1 }, blockId: { default: null } },
    },
    image: {
      group: 'block',
      atom: true,
      attrs: {
        src: { default: null },
        alt: { default: null },
        crop: { default: null },
        blockId: { default: null },
      },
    },
    linkedDatabase: {
      group: 'block',
      atom: true,
      attrs: { pageId: { default: null }, viewId: { default: null }, blockId: { default: null } },
    },
    columns: { group: 'block', content: 'column{2,7}', attrs: { widths: { default: null } } },
    column: { content: 'block*' },
    text: { group: 'inline' },
  },
});

describe('column resizing', () => {
  it('keeps two-column resizing continuous and clamps at the minimum share', () => {
    const before = [50, 50];
    const resized = resizeColumnWidths(before, 2, 0, 2.25, 18);

    expect(resized).toEqual([52.3, 47.7]);
    expect(resized[0]).not.toBe(55);
    expect(resized.reduce((sum, width) => sum + width, 0)).toBe(100);
    expect(resizeColumnWidths(before, 2, 0, 100, 18)).toEqual([82, 18]);
  });

  it('changes only the selected pair in a seven-column layout', () => {
    const before = normalizeColumnWidths(normalizeColumnWidths(null, 7), 7);
    const resized = resizeColumnWidths(before, 7, 2, 4.2, 5);

    expect(resized).toHaveLength(7);
    expect(resized.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(resized.slice(4)).toEqual(before.slice(4));
    expect(resized[2]! + resized[3]!).toBe(before[2]! + before[3]!);
    expect(resized.reduce((sum, width) => sum + width, 0)).toBe(100);
  });

  it('refuses readonly and no-op commits', () => {
    expect(shouldCommitColumnWidthResize(false, [50, 50], [60, 40])).toBe(false);
    expect(shouldCommitColumnWidthResize(true, [50, 50], null)).toBe(false);
    expect(shouldCommitColumnWidthResize(true, [50, 50], [50, 50])).toBe(false);
    expect(shouldCommitColumnWidthResize(true, [50, 50], [51, 49])).toBe(true);
  });

  it('resets a seven-column group to implicit equal widths without persisting an equal-width array', () => {
    const doc = schema.node('doc', null, [
      schema.node(
        'columns',
        { widths: [10, 12, 13, 14, 15, 16, 20] },
        Array.from({ length: 7 }, () => schema.node('column', null, [schema.node('paragraph')])),
      ),
    ]);
    const state = EditorState.create({ doc });
    const transaction = createColumnWidthsTransaction(
      state.tr,
      0,
      state.doc.nodeAt(0)!,
      normalizeColumnWidths(null, 7),
    );
    const reset = state.apply(transaction).doc.nodeAt(0)!;

    expect(reset.attrs.widths).toBeNull();
    expect(normalizeColumnWidths(reset.attrs.widths, reset.childCount)).toEqual(
      normalizeColumnWidths(null, 7),
    );
  });

  it('isolates resize from immediate edits before and after without a document-only boundary operation', () => {
    const imageAttrs = {
      src: 'attachments/sample.png',
      alt: 'Sample',
      crop: { x: 4, y: 5 },
      blockId: 'img-1',
    };
    const linkedAttrs = { pageId: 'database-page', viewId: 'board-view', blockId: 'linked-1' };
    const doc = schema.node('doc', null, [
      schema.node('columns', { widths: null }, [
        schema.node('column', null, [
          schema.node('heading', { level: 1, blockId: 'heading-1' }, schema.text('Heading')),
          schema.node('image', imageAttrs),
        ]),
        schema.node('column', null, [schema.node('linkedDatabase', linkedAttrs)]),
      ]),
    ]);
    let state = EditorState.create({ doc, plugins: [history()] });
    const columnsPosition = 0;
    const headingPosition = columnsPosition + 2;
    const heading = state.doc.nodeAt(headingPosition)!;
    state = state.apply(state.tr.setNodeMarkup(headingPosition, undefined, { ...heading.attrs, level: 2 }));
    const columns = state.doc.nodeAt(columnsPosition)!;
    const beforeSubtree = columns.toJSON();
    state = state.apply(createColumnWidthsTransaction(state.tr, columnsPosition, columns, [65, 35]));

    expect(state.doc.nodeAt(columnsPosition)?.attrs.widths).toEqual([65, 35]);
    expect(state.doc.nodeAt(columnsPosition)?.toJSON()).toEqual({
      ...beforeSubtree,
      attrs: { widths: [65, 35] },
    });

    const afterResize = state.doc;
    const boundary = closeColumnResizeHistory(state.tr);
    expect(boundary.steps).toHaveLength(0);
    state = state.apply(boundary);
    const textPosition = headingPosition + 1 + 'Heading'.length;
    state = state.apply(state.tr.insertText('!', textPosition));

    let afterOneUndo = state;
    expect(undo(state, (transaction) => (afterOneUndo = state.apply(transaction)))).toBe(true);
    expect(afterOneUndo.doc.nodeAt(columnsPosition)?.attrs.widths).toEqual([65, 35]);
    expect(afterOneUndo.doc.nodeAt(headingPosition)?.attrs.level).toBe(2);
    expect(afterOneUndo.doc.textContent).toContain('Heading');
    expect(afterOneUndo.doc.textContent).not.toContain('Heading!');

    let afterTwoUndos = afterOneUndo;
    expect(undo(afterOneUndo, (transaction) => (afterTwoUndos = afterOneUndo.apply(transaction)))).toBe(true);
    expect(afterTwoUndos.doc.nodeAt(columnsPosition)?.attrs.widths).toBeNull();
    expect(afterTwoUndos.doc.nodeAt(headingPosition)?.attrs.level).toBe(2);
    expect(afterTwoUndos.doc.textContent).toContain('Heading');

    let afterThreeUndos = afterTwoUndos;
    expect(undo(afterTwoUndos, (transaction) => (afterThreeUndos = afterTwoUndos.apply(transaction)))).toBe(
      true,
    );
    expect(afterThreeUndos.doc.eq(doc)).toBe(true);
    expect(afterResize.nodeAt(columnsPosition)?.attrs.widths).toEqual([65, 35]);
    expect(afterThreeUndos.doc.nodeAt(headingPosition)?.attrs.level).toBe(1);
  });
});
