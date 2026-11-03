import { Schema } from '@tiptap/pm/model';
import type { ReactNodeViewRendererOptions } from '@tiptap/react';
import { describe, expect, it } from 'vitest';
import { calculatedResultNodeViewOptions } from './calculatedResultNodeView';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    calculatedResult: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        pageId: { default: null },
        resultId: { default: null },
        name: { default: '' },
        formula: { default: '' },
        bindings: { default: [] },
        outputType: { default: 'auto' },
        format: { default: {} },
      },
    },
  },
});

type RendererUpdate = NonNullable<ReactNodeViewRendererOptions['update']>;

function update(
  hostPageId: string,
  oldAttrs: Record<string, unknown>,
  newAttrs: Record<string, unknown>,
): { accepted: boolean; updatePropsCalls: number } {
  const updateNodeView = calculatedResultNodeViewOptions(hostPageId).update;
  if (!updateNodeView) throw new Error('Calculated result renderer must define an update guard.');
  let updatePropsCalls = 0;
  const accepted = (updateNodeView as RendererUpdate)({
    oldNode: schema.nodes.calculatedResult!.create(oldAttrs),
    newNode: schema.nodes.calculatedResult!.create(newAttrs),
    oldDecorations: [],
    newDecorations: [],
    oldInnerDecorations: undefined as never,
    innerDecorations: undefined as never,
    updateProps: () => updatePropsCalls++,
  });
  return { accepted, updatePropsCalls };
}

describe('calculated result node view identity', () => {
  it('recreates the view when pageId or resultId changes', () => {
    const original = { pageId: 'page-a', resultId: 'result-a', formula: '1 + 1' };
    expect(update('host', original, { ...original, resultId: 'result-b' })).toEqual({
      accepted: false,
      updatePropsCalls: 0,
    });
    expect(update('host', original, { ...original, pageId: 'page-b' })).toEqual({
      accepted: false,
      updatePropsCalls: 0,
    });
  });

  it('updates attributes in place when the effective pageId and resultId stay the same', () => {
    const before = { pageId: 'page-a', resultId: 'result-a', formula: '1 + 1', name: 'Before' };
    const after = { ...before, formula: '2 + 2', name: 'After' };
    expect(update('host', before, after)).toEqual({ accepted: true, updatePropsCalls: 1 });
  });

  it('uses the extension host page when the node has no explicit pageId', () => {
    expect(update('host', { pageId: null, resultId: 'result-a' }, { pageId: 'host', resultId: 'result-a' })).toEqual({
      accepted: true,
      updatePropsCalls: 1,
    });
    expect(update('host', { pageId: null, resultId: 'result-a' }, { pageId: 'other', resultId: 'result-a' })).toEqual({
      accepted: false,
      updatePropsCalls: 0,
    });
  });
});
