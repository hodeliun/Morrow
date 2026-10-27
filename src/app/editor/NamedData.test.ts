import { Fragment, Schema, Slice } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../core/commands';
import type { Command } from '../../core/commands';
import { emptyWorkspace } from '../../core/model';
import type { NamedControlDef, WorkspaceState } from '../../core/model';
import type { WorkspaceSession } from '../../storage/session';
import { setSession } from '../workspace';
import { NamedControl } from './NamedData';

function apply(state: WorkspaceState, command: Command): WorkspaceState {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
}

describe('named data block paste', () => {
  it('clones pasted controls and results while keeping references outside the slice external', () => {
    let state = emptyWorkspace();
    state = apply(state, { type: 'page.create', id: 'source', parentId: null, now: 1 });
    state = apply(state, { type: 'page.create', id: 'host', parentId: null, now: 1 });
    const definitions: NamedControlDef[] = [
      { id: 'source-control', name: 'Filter', type: 'text', value: 'live', defaultValue: '', options: [] },
      { id: 'external-control', name: 'Outside', type: 'text', value: 'external', defaultValue: '', options: [] },
    ];
    for (const control of definitions) {
      state = apply(state, { type: 'page.control.configure', id: 'source', control, now: 2 });
    }

    const schema = new Schema({ nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*' },
      text: { group: 'inline' },
      namedControl: { group: 'inline', inline: true, atom: true, attrs: { controlId: { default: null }, pageId: { default: null }, label: { default: '' } } },
      calculatedResult: { group: 'inline', inline: true, atom: true, attrs: {
        resultId: { default: null }, pageId: { default: null }, name: { default: '' }, formula: { default: '' },
        bindings: { default: [] }, outputType: { default: 'auto' }, format: { default: {} },
      } },
    } });
    const formula = 'Filter + Outside + Nested';
    const span = (source: string) => {
      const start = formula.indexOf(source);
      return { start, end: start + source.length, source };
    };
    const internalControl = { ...span('Filter'), kind: 'control' as const, pageId: 'source', controlId: 'source-control' };
    const externalControl = { ...span('Outside'), kind: 'control' as const, pageId: 'source', controlId: 'external-control' };
    const internalResult = { ...span('Nested'), kind: 'result' as const, pageId: 'source', resultId: 'nested-result' };
    const slice = new Slice(Fragment.from(schema.node('paragraph', null, [
      schema.node('namedControl', { controlId: 'source-control', pageId: 'source', label: 'Filter' }),
      schema.node('calculatedResult', {
        resultId: 'total-result', pageId: 'source', name: 'Total', formula,
        bindings: [internalControl, externalControl, internalResult], outputType: 'currency', format: { currency: 'BRL' },
      }),
      schema.node('calculatedResult', {
        resultId: 'nested-result', pageId: 'source', name: 'Nested', formula: '1', bindings: [],
      }),
    ])), 0, 0);

    setSession({
      getState: () => state,
      execute(command: Command) {
        const result = applyCommand(state, command);
        if (!result.ok) return result;
        state = result.value.state;
        return { ok: true as const, value: state };
      },
    } as unknown as WorkspaceSession);

    const extension = NamedControl.configure({ hostPageId: 'host' });
    const pluginFactory = extension.config.addProseMirrorPlugins;
    expect(pluginFactory).toBeDefined();
    const plugins = pluginFactory!.call({
      name: 'namedControl', options: extension.options, storage: {},
      editor: { isEditable: true } as never, type: undefined as never, parent: undefined,
    });
    const transformPasted = plugins[0]!.spec.props?.transformPasted;
    expect(transformPasted).toBeDefined();
    const paste = () => transformPasted!.call(plugins[0]!.props as never, slice, {} as never, false);
    const first = paste();
    const second = paste();
    const firstControl = first.content.firstChild!.firstChild!;
    const firstResult = first.content.firstChild!.child(1);
    const firstNested = first.content.firstChild!.child(2);
    const secondControl = second.content.firstChild!.firstChild!;
    const secondResult = second.content.firstChild!.child(1);
    expect(firstControl.attrs.pageId).toBe('host');
    expect(firstControl.attrs.controlId).not.toBe('source-control');
    expect(secondControl.attrs.controlId).not.toBe(firstControl.attrs.controlId);
    expect(firstControl.attrs.label).toBe('Filter copy');
    expect(secondControl.attrs.label).toBe('Filter copy 2');
    expect(firstResult.attrs.resultId).not.toBe('total-result');
    expect(secondResult.attrs.resultId).not.toBe(firstResult.attrs.resultId);
    expect(firstNested.attrs.resultId).toBe(firstResult.attrs.bindings[2].resultId);
    expect(firstResult.attrs.bindings).toMatchObject([
      { kind: 'control', pageId: 'host', controlId: firstControl.attrs.controlId },
      { kind: 'control', pageId: 'source', controlId: 'external-control' },
      { kind: 'result', pageId: 'host', resultId: firstNested.attrs.resultId },
    ]);
    expect(state.pages.host!.controls).toHaveLength(2);
  });
});
