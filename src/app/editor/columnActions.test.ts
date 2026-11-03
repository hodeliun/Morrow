import { describe, expect, it } from 'vitest';
import { history, undo } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import {
  canApplyBlockDrop,
  closestBlockDropSide,
  createColumnRemovalTransaction,
  createParagraphBesideBlockTransaction,
  emptyColumnAtBackspaceBoundary,
  findColumnTarget,
  isEmptyColumn,
} from './columnActions';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block',
      content: 'text*',
      attrs: { blockId: { default: null }, blockBackground: { default: null } },
    },
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
    table: {
      group: 'block',
      atom: true,
      attrs: { tableId: { default: null }, widths: { default: null }, futureState: { default: null } },
    },
    linkedDatabaseView: {
      group: 'block',
      atom: true,
      attrs: { view: { default: null }, blockId: { default: null } },
    },
    columns: { group: 'block', content: 'column{2,7}', attrs: { widths: { default: null }, marker: { default: null } } },
    column: { content: 'block+', attrs: { blockBackground: { default: null } } },
    text: { group: 'inline' },
  },
});

const paragraph = (text: string, blockId: string | null = null, blockBackground: string | null = null) =>
  schema.node('paragraph', { blockId, blockBackground }, text ? schema.text(text) : undefined);

describe('column actions', () => {
  it('preserves child nodes and IDs, moves removed content after the group, and renormalizes widths', () => {
    const image = schema.node('image', {
      src: 'attachments/portrait.png',
      alt: 'Portrait',
      crop: { x: 1, y: 2, width: 60, height: 70 },
      blockId: 'image-middle',
    });
    const doc = schema.node('doc', null, [
      schema.node('columns', { widths: [20, 35, 45], marker: 'keep-me' }, [
        schema.node('column', { blockBackground: null }, [paragraph('Left', 'left-id')]),
        schema.node('column', { blockBackground: 'surface' }, [image]),
        schema.node('column', { blockBackground: null }, [paragraph('Right', 'right-id')]),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const target = findColumnTarget(doc, 0, 1)!;
    const transaction = createColumnRemovalTransaction(state, target, 'preserve')!;
    const next = state.apply(transaction).doc;

    expect(next.childCount).toBe(2);
    expect(next.child(0).type.name).toBe('columns');
    expect(next.child(0).attrs).toEqual({ widths: [30.8, 69.2], marker: 'keep-me' });
    expect(next.child(0).child(0).firstChild?.attrs.blockId).toBe('left-id');
    expect(next.child(0).child(1).firstChild?.attrs.blockId).toBe('right-id');
    expect(next.child(1).toJSON()).toEqual(image.toJSON());
    expect(next.child(1).attrs.crop).toEqual({ x: 1, y: 2, width: 60, height: 70 });
  });

  it('unwraps a two-column group with remaining children before preserved removed children', () => {
    const table = schema.node('table', {
      tableId: 'table-1',
      widths: [24, 76],
      futureState: { preserved: true },
    });
    const linked = schema.node('linkedDatabaseView', {
      view: { id: 'view-1', sourceId: 'database-1', filter: { future: true } },
      blockId: 'linked-1',
    });
    const doc = schema.node('doc', null, [
      schema.node('columns', { widths: [25, 75], marker: 'container-only' }, [
        schema.node('column', null, [paragraph('Moved one', 'moved-1'), table, linked]),
        schema.node('column', null, [paragraph('Kept first', 'kept-1'), paragraph('Kept second', 'kept-2')]),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const target = findColumnTarget(doc, 0, 0)!;
    const next = state.apply(createColumnRemovalTransaction(state, target, 'preserve')!).doc;

    expect(next.childCount).toBe(5);
    expect(next.child(0).attrs.blockId).toBe('kept-1');
    expect(next.child(1).attrs.blockId).toBe('kept-2');
    expect(next.child(2).attrs.blockId).toBe('moved-1');
    expect(next.child(3).toJSON()).toEqual(table.toJSON());
    expect(next.child(4).toJSON()).toEqual(linked.toJSON());
  });

  it('keeps discard as a distinct transform and removes only the chosen column contents', () => {
    const doc = schema.node('doc', null, [
      schema.node('columns', { widths: [40, 60] }, [
        schema.node('column', null, [paragraph('Delete me', 'delete-id')]),
        schema.node('column', null, [paragraph('Keep me', 'keep-id')]),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const target = findColumnTarget(doc, 0, 0)!;
    const next = state.apply(createColumnRemovalTransaction(state, target, 'discard')!).doc;

    expect(next.childCount).toBe(1);
    expect(next.child(0).attrs.blockId).toBe('keep-id');
    expect(next.textContent).toBe('Keep me');
  });

  it('only treats a default empty paragraph as removable without confirmation', () => {
    const empty = schema.node('column', null, [paragraph('')]);
    expect(isEmptyColumn(empty)).toBe(true);
    expect(isEmptyColumn(schema.node('column', { blockBackground: 'accent' }, [paragraph('')]))).toBe(false);
    expect(isEmptyColumn(schema.node('column', null, [paragraph('', 'stable-id')]))).toBe(false);
    expect(isEmptyColumn(schema.node('column', null, [paragraph('', null, 'accent')]))).toBe(false);
    expect(isEmptyColumn(schema.node('column', null, [paragraph(' ')]))).toBe(false);
  });

  it('removes a default empty column without adding a placeholder and undoes as one transaction', () => {
    const doc = schema.node('doc', null, [
      schema.node('columns', { widths: [20, 30, 50] }, [
        schema.node('column', null, [paragraph('Left', 'left-id')]),
        schema.node('column', null, [paragraph('')]),
        schema.node('column', null, [paragraph('Right', 'right-id')]),
      ]),
    ]);
    let state = EditorState.create({ doc, plugins: [history()] });
    const target = findColumnTarget(doc, 0, 1)!;
    state = state.apply(createColumnRemovalTransaction(state, target, 'preserve')!);

    expect(state.doc.childCount).toBe(1);
    expect(state.doc.child(0).type.name).toBe('columns');
    expect(state.doc.child(0).childCount).toBe(2);
    expect(state.doc.child(0).child(0).firstChild?.attrs.blockId).toBe('left-id');
    expect(state.doc.child(0).child(1).firstChild?.attrs.blockId).toBe('right-id');
    expect(state.doc.child(0).attrs.widths).toEqual([28.6, 71.4]);

    let undone = state;
    expect(undo(state, (transaction) => (undone = state.apply(transaction)))).toBe(true);
    expect(undone.doc.eq(doc)).toBe(true);

    const identified = schema.node('doc', null, [
      schema.node('columns', null, [
        schema.node('column', null, [paragraph('Left')]),
        schema.node('column', { blockBackground: 'surface' }, [paragraph('', 'identified-empty')]),
        schema.node('column', null, [paragraph('Right')]),
      ]),
    ]);
    const identifiedState = EditorState.create({ doc: identified });
    const identifiedTarget = findColumnTarget(identified, 0, 1)!;
    const preserved = identifiedState.apply(
      createColumnRemovalTransaction(identifiedState, identifiedTarget, 'preserve')!,
    ).doc;
    expect(preserved.childCount).toBe(2);
    expect(preserved.child(1).attrs.blockId).toBe('identified-empty');
  });

  it('allows Backspace only at the start of the sole default empty paragraph in a column', () => {
    const empty = schema.node('columns', null, [
      schema.node('column', null, [paragraph('')]),
      schema.node('column', null, [paragraph('Other')]),
    ]);
    const emptyDoc = schema.node('doc', null, [empty]);
    const emptyStart = TextSelection.create(emptyDoc, 3);
    expect(emptyColumnAtBackspaceBoundary(emptyDoc, emptyStart)?.index).toBe(0);

    const earlierText = paragraph('Keep this');
    const laterEmpty = schema.node('columns', null, [
      schema.node('column', null, [earlierText, paragraph('')]),
      schema.node('column', null, [paragraph('Other')]),
    ]);
    const laterDoc = schema.node('doc', null, [laterEmpty]);
    const laterStart = 2 + earlierText.nodeSize + 1;
    expect(emptyColumnAtBackspaceBoundary(laterDoc, TextSelection.create(laterDoc, laterStart))).toBeNull();

    const typed = schema.node('columns', null, [
      schema.node('column', null, [paragraph('Keep this')]),
      schema.node('column', null, [paragraph('Other')]),
    ]);
    const typedDoc = schema.node('doc', null, [typed]);
    expect(emptyColumnAtBackspaceBoundary(typedDoc, TextSelection.create(typedDoc, 3))).toBeNull();
  });

  it('rejects a stale confirmation target if the group changed before confirmation', () => {
    const doc = schema.node('doc', null, [
      schema.node('columns', null, [
        schema.node('column', null, [paragraph('One')]),
        schema.node('column', null, [paragraph('Two')]),
      ]),
    ]);
    const target = findColumnTarget(doc, 0, 0)!;
    const state = EditorState.create({ doc });
    const changed = state.apply(state.tr.insertText('!', 4));

    expect(createColumnRemovalTransaction(changed, target, 'preserve')).toBeNull();
  });

  it('makes removal one undoable transaction and preserves the full original document on undo', () => {
    const doc = schema.node('doc', null, [
      paragraph('Before', 'before-id'),
      schema.node('columns', { widths: [35, 65] }, [
        schema.node('column', null, [paragraph('Moved', 'moved-id')]),
        schema.node('column', null, [schema.node('image', { src: 'attachments/chart.svg', blockId: 'chart-id' })]),
      ]),
    ]);
    let state = EditorState.create({ doc, plugins: [history()] });
    const target = findColumnTarget(doc, 0 + paragraph('Before').nodeSize, 0)!;
    state = state.apply(createColumnRemovalTransaction(state, target, 'preserve')!);
    expect(state.doc.childCount).toBe(3);

    let undone = state;
    expect(undo(state, (transaction) => (undone = state.apply(transaction)))).toBe(true);
    expect(undone.doc.eq(doc)).toBe(true);
  });

  it('inserts a sibling paragraph before or after a block without recreating it', () => {
    const image = schema.node('image', { src: 'attachments/illustration.png', blockId: 'image-id' });
    const doc = schema.node('doc', null, [paragraph('Before'), image, paragraph('After')]);
    const state = EditorState.create({ doc });
    const imagePosition = doc.child(0).nodeSize;
    const after = state.apply(createParagraphBesideBlockTransaction(state, imagePosition, 'after')!).doc;
    const before = state.apply(createParagraphBesideBlockTransaction(state, imagePosition, 'before')!).doc;

    expect(after.childCount).toBe(4);
    expect(after.child(1).toJSON()).toEqual(image.toJSON());
    expect(after.child(2).type.name).toBe('paragraph');
    expect(before.childCount).toBe(4);
    expect(before.child(1).type.name).toBe('paragraph');
    expect(before.child(2).toJSON()).toEqual(image.toJSON());
  });

  it('chooses exactly one closest edge for block-drop feedback', () => {
    const rect = { left: 0, right: 600, top: 100, bottom: 300 };
    expect(closestBlockDropSide(rect, 300, 103)).toBe('top');
    expect(closestBlockDropSide(rect, 300, 297)).toBe('bottom');
    expect(closestBlockDropSide(rect, 3, 200)).toBe('left');
    expect(closestBlockDropSide(rect, 597, 200)).toBe('right');
  });

  it('rejects a drop after readonly changes or its captured target becomes stale', () => {
    const target = schema.node('image', { src: 'attachments/diagram.png' });
    const doc = schema.node('doc', null, [target]);
    expect(canApplyBlockDrop(true, doc, 0, target)).toBe(true);
    expect(canApplyBlockDrop(false, doc, 0, target)).toBe(false);

    const changed = schema.node('image', { src: 'attachments/replaced.png' });
    const changedDoc = schema.node('doc', null, [changed]);
    expect(canApplyBlockDrop(true, changedDoc, 0, target)).toBe(false);
  });

  it('inserts a paragraph within the same column as an image', () => {
    const image = schema.node('image', { src: 'attachments/diagram.png', blockId: 'image-id' });
    const columns = schema.node('columns', null, [
      schema.node('column', null, [paragraph('Before'), image, paragraph('After')]),
      schema.node('column', null, [paragraph('Other column')]),
    ]);
    const doc = schema.node('doc', null, [columns]);
    const state = EditorState.create({ doc });
    const imagePosition = 2 + paragraph('Before').nodeSize;
    const transaction = createParagraphBesideBlockTransaction(state, imagePosition, 'after')!;
    const next = state.apply(transaction).doc;

    expect(next.child(0).child(0).childCount).toBe(4);
    expect(next.child(0).child(0).child(1).attrs.blockId).toBe('image-id');
    expect(next.child(0).child(0).child(2).type.name).toBe('paragraph');
    expect(next.child(0).child(1).firstChild?.textContent).toBe('Other column');
  });

  it('offers a paragraph immediately before or after a whole columns group', () => {
    const group = schema.node('columns', { marker: 'keep-group' }, [
      schema.node('column', null, [paragraph('Left')]),
      schema.node('column', null, [paragraph('Right')]),
    ]);
    const doc = schema.node('doc', null, [group, paragraph('Following')]);
    const state = EditorState.create({ doc });
    const before = state.apply(createParagraphBesideBlockTransaction(state, 0, 'before')!).doc;
    const after = state.apply(createParagraphBesideBlockTransaction(state, 0, 'after')!).doc;

    expect(before.child(0).type.name).toBe('paragraph');
    expect(before.child(1).toJSON()).toEqual(group.toJSON());
    expect(after.child(0).toJSON()).toEqual(group.toJSON());
    expect(after.child(1).type.name).toBe('paragraph');
    expect(after.child(2).attrs.blockId).toBeNull();
  });
});
