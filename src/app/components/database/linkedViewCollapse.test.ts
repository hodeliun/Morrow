import { Schema } from '@tiptap/pm/model';
import { history, undo } from '@tiptap/pm/history';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import type { ViewDef } from '../../../core/model';
import {
  linkedViewCollapseEnabled,
  linkedViewSourceSelectionAttributes,
  withLinkedViewCollapseEnabled,
} from './LinkedDatabaseView';

const view = (changes: Partial<ViewDef> = {}): ViewDef => ({
  id: 'synthetic-view',
  name: 'Synthetic view',
  type: 'table',
  filters: [],
  sorts: [],
  groupBy: null,
  dateProp: null,
  hidden: [],
  ...changes,
});

describe('linked view collapse option', () => {
  it('keeps the fold control enabled for legacy views without the option', () => {
    expect(linkedViewCollapseEnabled(view())).toBe(true);
  });

  it('hides the control when opted out without discarding the saved collapsed state', () => {
    const disabled = view({ collapseEnabled: false, collapsed: true });

    expect(linkedViewCollapseEnabled(disabled)).toBe(false);
    expect(disabled.collapsed).toBe(true);
  });

  it('preserves existing and future view keys when the opt-in flag changes', () => {
    const original = { ...view({ collapsed: true }), futureViewKey: { opaque: true } };
    const disabled = withLinkedViewCollapseEnabled(original, false);

    expect(disabled).toMatchObject({
      collapseEnabled: false,
      collapsed: true,
      futureViewKey: { opaque: true },
    });
  });

  it('clears raw marker compatibility state when a different source view is selected', () => {
    const selected = linkedViewSourceSelectionAttributes(
      'host-page',
      'new-database',
      'linked-block',
      view(),
    );

    expect(selected).toMatchObject({
      hostPageId: 'host-page',
      sourceDatabaseId: 'new-database',
      blockId: 'linked-block',
      view: { id: 'synthetic-view' },
      viewRawState: null,
    });
  });

  it('records disabling and restoring a linked view fold as undoable single-node updates', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        linkedDatabaseView: {
          group: 'block',
          atom: true,
          attrs: {
            sourceDatabaseId: { default: null },
            blockId: { default: null },
            view: { default: null },
          },
        },
        text: { group: 'inline' },
      },
    });
    const original = schema.node('doc', null, [
      schema.node('linkedDatabaseView', {
        sourceDatabaseId: 'source-database',
        blockId: 'linked-view-block',
        view: { ...view({ collapsed: true }), futureViewKey: { opaque: true } },
      }),
    ]);
    let state = EditorState.create({ schema, doc: original, plugins: [history()] });
    const node = state.doc.child(0);
    const initialView = node.attrs.view as object;
    state = state.apply(
      state.tr.setNodeMarkup(0, undefined, {
        ...node.attrs,
        view: withLinkedViewCollapseEnabled(initialView, false),
      }),
    );
    const disabled = state.doc.child(0).attrs.view as Record<string, unknown>;
    expect(disabled).toMatchObject({ collapseEnabled: false, collapsed: true });

    let undone = state;
    expect(undo(state, (tr) => (undone = state.apply(tr)))).toBe(true);
    expect(undone.doc.eq(original)).toBe(true);
  });
});
