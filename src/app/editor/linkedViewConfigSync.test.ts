import { history, undo } from '@tiptap/pm/history';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import type { DocNode } from '../../core/model';
import { runLinkedViewConfigWrite, prepareLinkedViewConfigSync } from './linkedViewConfigSync';
import { registerPageEditor } from './pageEditorRegistry';
import type { Editor } from '@tiptap/core';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    linkedDatabaseView: {
      group: 'block',
      atom: true,
      attrs: {
        hostPageId: { default: 't22-note' },
        sourceDatabaseId: { default: null },
        blockId: { default: null },
        view: { default: null },
        viewRawState: { default: null },
      },
    },
  },
  marks: { strong: {}, em: {} },
});

function fixtureDoc(text = 'pending'): DocNode {
  const linked = (blockId: string, viewId: string, name: string): DocNode => ({
    type: 'linkedDatabaseView',
    attrs: {
      hostPageId: 't22-note',
      sourceDatabaseId: 't22-database',
      blockId,
      futureLinkedFlag: { keep: `node-${blockId}` },
      view: {
        id: viewId,
        name,
        type: 'table',
        order: ['title'],
        futureViewFlag: { keep: `view-${viewId}` },
      },
      viewRawState: {
        raw: {
          sourceDatabaseId: 't22-database',
          blockId,
          futureLinkedFlag: { keep: `marker-${blockId}` },
          view: { id: viewId, name, type: 'table', futureRawFlag: { keep: viewId } },
        },
        baseline: { sourceDatabaseId: 't22-database', blockId },
      },
    },
  });

  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text, marks: [{ type: 'strong' }] }],
      },
      linked('t22-linked-a', 't22-view-a', 'Primary A'),
      linked('t22-linked-b', 't22-view-b', 'Primary B'),
      { type: 'paragraph' },
    ],
  };
}

function renamed(doc: DocNode, blockId: string, name: string): DocNode {
  const next = structuredClone(doc);
  const node = next.content!.find((child) => child.attrs?.blockId === blockId)!;
  const attrs = node.attrs as Record<string, unknown>;
  const view = attrs.view as Record<string, unknown>;
  view.name = name;
  const rawState = attrs.viewRawState as { raw: { view: Record<string, unknown> } };
  rawState.raw.view.name = name;
  return next;
}

function shareLinkedViewId(doc: DocNode, viewId: string): DocNode {
  const next = structuredClone(doc);
  for (const node of next.content ?? []) {
    if (node.type !== 'linkedDatabaseView' || !node.attrs) continue;
    const view = node.attrs.view as Record<string, unknown>;
    view.id = viewId;
    const rawState = node.attrs.viewRawState as { raw: { view: Record<string, unknown> } };
    rawState.raw.view.id = viewId;
  }
  return next;
}

function editorState(doc: DocNode): EditorState {
  return EditorState.create({ schema, doc: schema.nodeFromJSON(doc), plugins: [history()] });
}

function addTypedText(state: EditorState, text: string): EditorState {
  const firstParagraph = state.doc.child(0);
  const position = 1 + firstParagraph.content.size;
  return state.apply(state.tr.insertText(text, position));
}

function mirrorCurrentState(state: EditorState, target: DocNode): EditorState {
  const targetDoc = schema.nodeFromJSON(target);
  const attrsByBlockId = new Map<string, Record<string, unknown>>();
  targetDoc.descendants((node) => {
    if (node.type.name === 'linkedDatabaseView' && typeof node.attrs.blockId === 'string')
      attrsByBlockId.set(node.attrs.blockId, node.attrs);
  });
  let transaction = state.tr;
  state.doc.descendants((node, position) => {
    const attrs = attrsByBlockId.get(node.attrs.blockId);
    if (node.type.name === 'linkedDatabaseView' && attrs)
      transaction = transaction.setNodeMarkup(position, undefined, attrs, node.marks);
  });
  transaction.setMeta('addToHistory', false);
  return state.apply(transaction);
}

function apply(state: EditorState, transaction: Transaction): EditorState {
  return state.apply(transaction);
}

function linkedNames(doc: ProseMirrorNode): string[] {
  const names: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'linkedDatabaseView') names.push(node.attrs.view.name);
  });
  return names;
}

function textContent(doc: ProseMirrorNode): string {
  return doc.textBetween(0, doc.content.size, '\n');
}

describe('linked view configuration synchronization', () => {
  it('mirrors every linked-only delta without putting it in native undo history', () => {
    const stateA = addTypedText(editorState(fixtureDoc()), 'Z');
    const before = stateA.doc.toJSON() as DocNode;
    const after = renamed(renamed(before, 't22-linked-a', 'Renamed A'), 't22-linked-b', 'Renamed B');
    // The initiating pane already applied its existing narrow linked-view mirror.
    const activePane = mirrorCurrentState(stateA, after);
    const initiating = prepareLinkedViewConfigSync(
      activePane,
      't22-note',
      before,
      after,
    );
    expect(initiating.status).toBe('already-current');

    // A second pane receives the same authoritative document update through PageEditor sync.
    const secondaryPane = addTypedText(editorState(fixtureDoc()), 'Z');
    const secondary = prepareLinkedViewConfigSync(secondaryPane, 't22-note', before, after);
    expect(secondary.status).toBe('transaction');
    if (secondary.status !== 'transaction') throw new Error('Expected linked view sync transaction.');
    expect(secondary.changes.map((change) => change.identity)).toEqual([
      { kind: 'linked', hostPageId: 't22-note', blockId: 't22-linked-a' },
      { kind: 'linked', hostPageId: 't22-note', blockId: 't22-linked-b' },
    ]);
    expect(secondary.transaction.steps).toHaveLength(2);
    expect(secondary.transaction.getMeta('addToHistory')).toBe(false);
    expect(secondary.transaction.getMeta('preventUpdate')).toBe(true);
    const secondaryAfterConfig = apply(secondaryPane, secondary.transaction);

    // Contextual Undo uses the same narrow mirror in both panes.
    const activeUndo = prepareLinkedViewConfigSync(activePane, 't22-note', after, before);
    const secondaryUndo = prepareLinkedViewConfigSync(secondaryAfterConfig, 't22-note', after, before);
    expect(activeUndo.status).toBe('transaction');
    expect(secondaryUndo.status).toBe('transaction');
    if (activeUndo.status !== 'transaction' || secondaryUndo.status !== 'transaction')
      throw new Error('Expected linked view Undo mirror transactions.');
    const activeAfterContextualUndo = apply(activePane, activeUndo.transaction);
    const secondaryAfterContextualUndo = apply(secondaryAfterConfig, secondaryUndo.transaction);
    expect(linkedNames(activeAfterContextualUndo.doc)).toEqual(['Primary A', 'Primary B']);
    expect(linkedNames(secondaryAfterContextualUndo.doc)).toEqual(['Primary A', 'Primary B']);
    expect(textContent(activeAfterContextualUndo.doc)).toContain('pendingZ');
    expect(textContent(secondaryAfterContextualUndo.doc)).toContain('pendingZ');

    let nativeUndo: Transaction | null = null;
    expect(undo(activeAfterContextualUndo, (transaction) => (nativeUndo = transaction))).toBe(true);
    expect(nativeUndo).not.toBeNull();
    const activeAfterTextUndo = apply(activeAfterContextualUndo, nativeUndo!);
    expect(textContent(activeAfterTextUndo.doc)).toContain('pending');
    expect(textContent(activeAfterTextUndo.doc)).not.toContain('pendingZ');
    expect(linkedNames(activeAfterTextUndo.doc)).toEqual(['Primary A', 'Primary B']);

    const linkedA = activeAfterTextUndo.doc.child(1).attrs;
    const linkedB = activeAfterTextUndo.doc.child(2).attrs;
    expect(linkedA.view.futureViewFlag).toEqual({ keep: 'view-t22-view-a' });
    expect(linkedA.viewRawState.raw.futureLinkedFlag).toEqual({ keep: 'marker-t22-linked-a' });
    expect(linkedB.viewRawState.raw.view.futureRawFlag).toEqual({ keep: 't22-view-b' });
    expect(activeAfterTextUndo.doc.child(0).firstChild!.marks.map((mark) => mark.type.name)).toEqual(['strong']);
  });

  it('syncs a legacy linked view whose stored attrs omit hostPageId', () => {
    const before = fixtureDoc();
    for (const node of before.content ?? []) {
      if (node.type === 'linkedDatabaseView') delete node.attrs!.hostPageId;
    }
    const after = renamed(before, 't22-linked-a', 'Legacy renamed');

    const result = prepareLinkedViewConfigSync(editorState(before), 't22-note', before, after);

    expect(result.status).toBe('transaction');
    if (result.status !== 'transaction') throw new Error('Expected a transaction for an omitted legacy host.');
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.identity).toEqual({ kind: 'linked', hostPageId: 't22-note', blockId: 't22-linked-a' });
    expect(before.content?.[1]?.attrs?.hostPageId).toBeUndefined();
    expect(after.content?.[1]?.attrs?.hostPageId).toBeUndefined();
  });

  it('allows distinct linked block identities to share a cloned view ID', () => {
    const before = shareLinkedViewId(fixtureDoc(), 't22-cloned-view');
    const after = renamed(renamed(before, 't22-linked-a', 'Renamed A'), 't22-linked-b', 'Renamed B');
    const result = prepareLinkedViewConfigSync(editorState(before), 't22-note', before, after);

    expect(result.status).toBe('transaction');
    if (result.status !== 'transaction') throw new Error('Expected shared-view-ID linked config sync.');
    expect(result.changes.map((change) => change.identity)).toEqual([
      { kind: 'linked', hostPageId: 't22-note', blockId: 't22-linked-a' },
      { kind: 'linked', hostPageId: 't22-note', blockId: 't22-linked-b' },
    ]);
    expect(result.changes.map((change) => change.before.view.id)).toEqual([
      't22-cloned-view',
      't22-cloned-view',
    ]);
  });

  it('reports already-current and stale live documents without creating a replacement transaction', () => {
    const before = fixtureDoc();
    const after = renamed(before, 't22-linked-a', 'Renamed A');
    const current = schema.nodeFromJSON(after);
    const alreadyCurrent = prepareLinkedViewConfigSync(
      EditorState.create({ schema, doc: current }),
      't22-note',
      before,
      after,
    );
    expect(alreadyCurrent.status).toBe('already-current');

    const stale = renamed(before, 't22-linked-a', 'Stale local config');
    const conflict = prepareLinkedViewConfigSync(
      EditorState.create({ schema, doc: schema.nodeFromJSON(stale) }),
      't22-note',
      before,
      after,
    );
    expect(conflict.status).toBe('conflict');
  });

  it('commits pending panes before source comparison and blocks a stale source write', () => {
    const before = fixtureDoc();
    const proposed = renamed(before, 't22-linked-a', 'Renamed A');
    let current = before;
    let paneDoc = before;
    const events: string[] = [];
    const write = vi.fn();
    const unregister = registerPageEditor('t22-note', { isDestroyed: false } as Editor, (expected) =>
      JSON.stringify(paneDoc) === JSON.stringify(expected),
    );

    try {
      const result = runLinkedViewConfigWrite({
        hostPageId: 't22-note',
        expectedDoc: before,
        proposedDoc: proposed,
        commitPending: () => {
          events.push('commit');
          current = structuredClone(before);
          current.content![0]!.content![0]!.text = 'text committed from another pane';
          paneDoc = current;
        },
        currentDoc: () => {
          events.push('current');
          return current;
        },
        reparse: () => {
          events.push('reparse');
          return proposed;
        },
        write,
      });

      expect(result.status).toBe('conflict');
      expect(events).toEqual(['commit', 'current']);
      expect(write).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('blocks an assistant proposal when its source changes during the async approval gap', async () => {
    const before = fixtureDoc();
    const proposed = renamed(before, 't22-linked-a', 'Renamed A');
    let current = before;
    let paneDoc = before;
    const write = vi.fn();
    const unregister = registerPageEditor('t22-note', { isDestroyed: false } as Editor, (expected) =>
      JSON.stringify(paneDoc) === JSON.stringify(expected),
    );

    try {
      await Promise.resolve();
      current = structuredClone(before);
      current.content![0]!.content![0]!.text = 'source changed while awaiting approval';
      paneDoc = current;

      const result = runLinkedViewConfigWrite({
        hostPageId: 't22-note',
        expectedDoc: before,
        proposedDoc: proposed,
        commitPending: () => undefined,
        currentDoc: () => current,
        reparse: () => proposed,
        write,
      });

      expect(result.status).toBe('conflict');
      expect(write).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it('blocks a stale registered pane and writes only after all live pane documents match', () => {
    const before = fixtureDoc();
    const proposed = renamed(before, 't22-linked-a', 'Renamed A');
    let paneDoc = structuredClone(before);
    paneDoc.content![0]!.content![0]!.text = 'uncommitted pane draft';
    const write = vi.fn((doc: DocNode) => doc);
    const unregister = registerPageEditor('t22-note', { isDestroyed: false } as Editor, (expected) =>
      JSON.stringify(paneDoc) === JSON.stringify(expected),
    );

    try {
      const blocked = runLinkedViewConfigWrite({
        hostPageId: 't22-note',
        expectedDoc: before,
        proposedDoc: proposed,
        commitPending: () => undefined,
        currentDoc: () => before,
        reparse: () => proposed,
        write,
      });
      expect(blocked.status).toBe('conflict');
      expect(write).not.toHaveBeenCalled();

      paneDoc = before;
      const applied = runLinkedViewConfigWrite({
        hostPageId: 't22-note',
        expectedDoc: before,
        proposedDoc: proposed,
        commitPending: () => undefined,
        currentDoc: () => before,
        reparse: () => proposed,
        write,
      });
      expect(applied).toEqual({ status: 'written', doc: proposed, result: proposed });
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it('does not classify text, marks, structure, or identity changes as linked-only', () => {
    const before = fixtureDoc();
    const configAndText = renamed(before, 't22-linked-a', 'Renamed A');
    configAndText.content![0]!.content![0]!.text = 'different text';
    const configAndStructure = renamed(before, 't22-linked-a', 'Renamed A');
    configAndStructure.content!.reverse();
    const configAndIdentity = renamed(before, 't22-linked-a', 'Renamed A');
    configAndIdentity.content![1]!.attrs!.sourceDatabaseId = 'different-source';
    const configAndBlockId = renamed(before, 't22-linked-a', 'Renamed A');
    configAndBlockId.content![1]!.attrs!.blockId = 'different-block';
    const configAndHostPageId = renamed(before, 't22-linked-a', 'Renamed A');
    configAndHostPageId.content![1]!.attrs!.hostPageId = 'different-host';
    const configAndOtherAttribute = renamed(before, 't22-linked-a', 'Renamed A');
    configAndOtherAttribute.content![1]!.attrs!.futureLinkedFlag = { keep: 'changed' };
    const configAndMarks = renamed(before, 't22-linked-a', 'Renamed A');
    configAndMarks.content![0]!.content![0]!.marks = [{ type: 'em' }];
    const changedViewId = structuredClone(before);
    changedViewId.content![1]!.attrs!.view = {
      ...(changedViewId.content![1]!.attrs!.view as Record<string, unknown>),
      id: 'different-view-id',
    };

    for (const next of [
      configAndText,
      configAndStructure,
      configAndIdentity,
      configAndBlockId,
      configAndHostPageId,
      configAndOtherAttribute,
      configAndMarks,
      changedViewId,
    ]) {
      const result = prepareLinkedViewConfigSync(
        editorState(before),
        't22-note',
        before,
        next,
      );
      expect(result.status).toBe('not-linked-only');
    }
  });

  it('rejects ambiguous duplicate linked-view identities', () => {
    const before = fixtureDoc();
    const duplicate = structuredClone(before);
    duplicate.content![2]!.attrs!.blockId = 't22-linked-a';
    const after = renamed(duplicate, 't22-linked-a', 'Renamed A');
    const result = prepareLinkedViewConfigSync(editorState(duplicate), 't22-note', duplicate, after);
    expect(result.status).toBe('not-linked-only');
  });
});
