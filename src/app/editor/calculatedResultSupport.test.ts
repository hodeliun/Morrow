import { describe, expect, it } from 'vitest';
import { history, redo, undo } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { DocNode } from '../../core/model';
import {
  captureCalculatedResultEditTarget,
  calculatedResultFormatError,
  closeCalculatedResultConfigurationHistory,
  createCalculatedResultConfigurationTransaction,
  findUnsupportedCalculatedResultContent,
  isCurrentCalculatedResultEditTarget,
  shouldRenderMarkdownSourceEditor,
} from './calculatedResultSupport';

const result = (attrs: Record<string, unknown> = {}) => ({
  type: 'calculatedResult',
  attrs: {
    resultId: 'result-1',
    name: '',
    formula: '',
    bindings: [],
    outputType: 'auto',
    format: {},
    pageId: 'page-1',
    ...attrs,
  },
});

describe('calculated result output format validation', () => {
  it('preserves legacy progress formats without imposing manual-control steps', () => {
    expect(calculatedResultFormatError('progress', { max: 100 })).toBeNull();
    expect(calculatedResultFormatError('progress', {})).toBeNull();
    expect(calculatedResultFormatError('progress', { min: 0, max: 0.3 })).toBeNull();
    expect(calculatedResultFormatError('progress', { min: 5, max: 4 })).toBeTruthy();
    expect(calculatedResultFormatError('progress', { min: 5, max: 5 })).toBeTruthy();
  });

  it('keeps explicit integer range and step validation for calculated scale', () => {
    expect(calculatedResultFormatError('scale', { min: 1, max: 5, step: 1 })).toBeNull();
    expect(calculatedResultFormatError('scale', { min: 1, max: 5, step: 0.5 })).toBeTruthy();
  });
});

describe('calculated result editor compatibility guard', () => {
  it('keeps result configuration separate from following prose in undo history', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        text: { group: 'inline' },
        calculatedResult: {
          inline: true,
          group: 'inline',
          atom: true,
          attrs: {
            resultId: { default: null }, pageId: { default: null }, name: { default: '' },
            formula: { default: '' }, bindings: { default: [] }, outputType: { default: 'auto' }, format: { default: {} },
          },
        },
      },
      marks: { bold: {}, italic: {} },
    });
    const originalAttrs = {
      resultId: 'result-1', pageId: 'page-1', name: '', formula: '', bindings: [], outputType: 'auto', format: {},
    };
    let state = EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph', null, [
        schema.text('A', [schema.mark('bold')]), schema.node('calculatedResult', originalAttrs), schema.text('Z', [schema.mark('italic')]),
      ])]),
      plugins: [history()],
    });
    const originalDoc = state.doc;
    const position = 2;
    const originalNode = state.doc.nodeAt(position)!;
    const savedAttrs = {
      name: 'Four result', formula: '4 + 0.7', bindings: [], outputType: 'number', format: { precision: 2 }, pageId: 'page-1',
    };
    state = state.apply(createCalculatedResultConfigurationTransaction(state.tr, position, originalNode, savedAttrs));
    state = state.apply(closeCalculatedResultConfigurationHistory(state.tr));
    state = state.apply(state.tr.insert(position + originalNode.nodeSize, schema.text('Neighbor', [schema.mark('italic')])));

    let afterTypingUndo = state;
    expect(undo(state, (transaction) => (afterTypingUndo = state.apply(transaction)))).toBe(true);
    expect(afterTypingUndo.doc.nodeAt(position)?.attrs).toMatchObject({
      ...savedAttrs,
      resultId: 'result-1',
      bindings: [],
    });
    expect(afterTypingUndo.doc.textContent).not.toContain('Neighbor');
    expect(afterTypingUndo.doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toContain('bold');
    expect(afterTypingUndo.doc.firstChild?.lastChild?.marks.map((mark) => mark.type.name)).toContain('italic');

    let afterSaveUndo = afterTypingUndo;
    expect(undo(afterTypingUndo, (transaction) => (afterSaveUndo = afterTypingUndo.apply(transaction)))).toBe(true);
    expect(afterSaveUndo.doc.nodeAt(position)?.attrs).toEqual(originalAttrs);
    expect(afterSaveUndo.doc.nodeAt(position)?.attrs.resultId).toBe('result-1');
    expect(afterSaveUndo.doc.eq(originalDoc)).toBe(true);

    let afterSaveRedo = afterSaveUndo;
    expect(redo(afterSaveUndo, (transaction) => (afterSaveRedo = afterSaveUndo.apply(transaction)))).toBe(true);
    expect(afterSaveRedo.doc.nodeAt(position)?.attrs).toMatchObject({
      ...savedAttrs,
      resultId: 'result-1',
      bindings: [],
    });
    expect(afterSaveRedo.doc.textContent).toBe('AZ');
    expect(afterSaveRedo.doc.firstChild?.child(0).marks.map((mark) => mark.type.name)).toContain('bold');
    expect(afterSaveRedo.doc.firstChild?.lastChild?.marks.map((mark) => mark.type.name)).toContain('italic');

    let afterNeighborRedo = afterSaveRedo;
    expect(redo(afterSaveRedo, (transaction) => (afterNeighborRedo = afterSaveRedo.apply(transaction)))).toBe(true);
    expect(afterNeighborRedo.doc.nodeAt(position)?.attrs).toMatchObject({
      ...savedAttrs,
      resultId: 'result-1',
      bindings: [],
    });
    expect(afterNeighborRedo.doc.textContent).toBe('ANeighborZ');
    expect(afterNeighborRedo.doc.firstChild?.child(2).marks.map((mark) => mark.type.name)).toContain('italic');
  });

  it('allows a known inline result between text and marks', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before ', marks: [{ type: 'bold' }] },
          result(),
          { type: 'text', text: ' after', marks: [{ type: 'italic' }] },
        ],
      }],
    };

    expect(findUnsupportedCalculatedResultContent(doc)).toEqual([]);
  });

  it('keeps a calculated result in block position on the readonly path', () => {
    const doc: DocNode = { type: 'doc', content: [result()] };

    expect(findUnsupportedCalculatedResultContent(doc)).toContain('calculatedResult block placement');
  });

  it('keeps unknown result attributes on the readonly path', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [result({ futureAttribute: { keep: true } })] }],
    };

    expect(findUnsupportedCalculatedResultContent(doc)).toContain('calculatedResult attributes');
  });

  it('keeps invalid formula bindings and formats on the readonly path', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [result({
          bindings: [{ kind: 'control', pageId: 'page-1', controlId: 'control-1', start: 0, end: 4, source: 'name' }],
          format: { privateFormat: 'preserve' },
        })],
      }],
    };

    expect(findUnsupportedCalculatedResultContent(doc)).toContain('calculatedResult attributes');
  });

  it('accepts new scale outputs and keeps legacy progress output formats on the editable path', () => {
    const valid: DocNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          result({ outputType: 'scale', format: { min: 1, max: 5, step: 1, scaleIcon: 'star', color: 'blue', showValue: true } }),
          result({ resultId: 'legacy-progress', outputType: 'progress', format: { max: 100 } }),
        ],
      }],
    };
    const invalid: DocNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [result({ outputType: 'scale', format: { min: 1, max: 5, step: 0.3 } })],
      }],
    };

    expect(findUnsupportedCalculatedResultContent(valid)).toEqual([]);
    expect(findUnsupportedCalculatedResultContent(invalid)).toContain('calculatedResult attributes');
  });

  it('does not mount a Markdown writer when source mode is active for an unsupported result', () => {
    const unsupported = findUnsupportedCalculatedResultContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [result({ futureAttribute: 'preserve' })] }],
    }).length > 0;

    expect(shouldRenderMarkdownSourceEditor('page-1', 'page-1', 'page', unsupported)).toBe(false);
    expect(shouldRenderMarkdownSourceEditor('page-1', 'page-1', 'page', false)).toBe(true);
  });

  it('revalidates owner, mapped position, result identity, page, and configuration around a commit', () => {
    const attrs = {
      resultId: 'result-1',
      pageId: 'page-1',
      name: '',
      formula: '1 + 2',
      bindings: [],
      outputType: 'number',
      format: { precision: 2 },
    };
    const node = { type: { name: 'calculatedResult' }, attrs: { ...attrs } };
    const positions = new Map([[3, null], [8, node]]);
    const editor = {
      isDestroyed: false,
      isEditable: true,
      state: { doc: { nodeAt: (position: number) => positions.get(position) ?? null } },
    };
    const target = captureCalculatedResultEditTarget(editor, 'page-1', 'result-1', attrs);
    let position = 3;
    const getPos = () => position;

    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    position = 8;
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(true);
    positions.set(8, null);
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    positions.set(8, node);
    node.attrs.formula = '9';
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    node.attrs.formula = attrs.formula;
    node.attrs.resultId = 'result-2';
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    node.attrs.resultId = attrs.resultId;
    node.attrs.pageId = 'other-page';
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    node.attrs.pageId = attrs.pageId;
    positions.set(8, null);
    expect(isCurrentCalculatedResultEditTarget(editor, getPos, target)).toBe(false);
    positions.set(8, node);
    expect(isCurrentCalculatedResultEditTarget({ ...editor, isEditable: false }, getPos, target)).toBe(false);
    expect(isCurrentCalculatedResultEditTarget({ ...editor, isDestroyed: true }, getPos, target)).toBe(false);
    expect(isCurrentCalculatedResultEditTarget({ ...editor, state: { doc: { nodeAt: () => null } } }, getPos, target)).toBe(false);
    expect(isCurrentCalculatedResultEditTarget({ ...editor }, getPos, target)).toBe(false);
  });
});
