import { describe, expect, it } from 'vitest';
import type { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import type { FormulaReferenceBinding, PageId } from '../../core/model';
import {
  captureCalculatedResultEditTarget,
  createCalculatedResultConfigurationTransaction,
  isCurrentCalculatedResultEditTarget,
} from './calculatedResultSupport';
import {
  calculatedResultFormulaDraftSeed,
  clearCalculatedResultDraft,
  readCalculatedResultDraft,
  writeCalculatedResultDraft,
} from './calculatedResultDrafts';
import type { CalculatedResultDraftSnapshot } from './calculatedResultDrafts';

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
        resultId: { default: null },
        pageId: { default: null },
        name: { default: '' },
        formula: { default: '' },
        bindings: { default: [] },
        outputType: { default: 'auto' },
        format: { default: {} },
      },
    },
  },
  marks: {},
});

const attrs = (pageId: PageId, resultId: string, name = 'Original') => ({
  pageId,
  resultId,
  name,
  formula: 'abc',
  bindings: [],
  outputType: 'number',
  format: { precision: 2 },
});

function docWithResults(...items: Array<ReturnType<typeof attrs>>): ProseMirrorNode {
  return schema.node(
    'doc',
    null,
    [schema.node('paragraph', null, items.map((item) => schema.node('calculatedResult', item)))],
  );
}

interface FakeEditor {
  isDestroyed: boolean;
  isEditable: boolean;
  state: { doc: ProseMirrorNode };
  on: (event: 'transaction' | 'destroy', listener: (...args: unknown[]) => void) => FakeEditor;
  off: (event: 'transaction' | 'destroy', listener: (...args: unknown[]) => void) => FakeEditor;
  emitTransaction: (
    doc: ProseMirrorNode,
    docChanged?: boolean,
    appendedTransactions?: Array<{ docChanged: boolean }>,
  ) => void;
  destroy: () => void;
  listenerCount: (event: 'transaction' | 'destroy') => number;
}

function fakeEditor(doc = docWithResults(attrs('page-a', 'result-1'))): { editor: Editor; fake: FakeEditor } {
  const listeners = new Map<'transaction' | 'destroy', Set<(...args: unknown[]) => void>>([
    ['transaction', new Set()],
    ['destroy', new Set()],
  ]);
  const fake: FakeEditor = {
    isDestroyed: false,
    isEditable: true,
    state: { doc },
    on(event, listener) {
      listeners.get(event)!.add(listener);
      return fake;
    },
    off(event, listener) {
      listeners.get(event)!.delete(listener);
      return fake;
    },
    emitTransaction(nextDoc, docChanged = true, appendedTransactions = []) {
      fake.state.doc = nextDoc;
      for (const listener of [...listeners.get('transaction')!])
        listener({ editor: fake, transaction: { docChanged }, appendedTransactions });
    },
    destroy() {
      fake.isDestroyed = true;
      for (const listener of [...listeners.get('destroy')!]) listener();
      listeners.get('transaction')!.clear();
      listeners.get('destroy')!.clear();
    },
    listenerCount(event) {
      return listeners.get(event)!.size;
    },
  };
  return { editor: fake as unknown as Editor, fake };
}

function makeDraft(owner: Editor, pageId: PageId, resultId: string): CalculatedResultDraftSnapshot {
  const originalAttrs = attrs(pageId, resultId);
  const bindings: FormulaReferenceBinding[] = [
    { kind: 'control', pageId, controlId: 'control-1', start: 0, end: 3, source: 'abc' },
  ];
  return {
    target: captureCalculatedResultEditTarget(owner, pageId, resultId, originalAttrs),
    config: { name: 'Draft name', outputType: 'number', format: { precision: 4 } },
    formula: 'abc',
    bindings,
  };
}

describe('calculated result ephemeral draft sessions', () => {
  it('isolates the same result id by Editor owner and page, and clones mutable values on both edges', () => {
    const { editor: ownerA } = fakeEditor(docWithResults(attrs('page-a', 'result-1'), attrs('page-b', 'result-1')));
    const { editor: ownerB } = fakeEditor();
    const draftA = makeDraft(ownerA, 'page-a', 'result-1');
    const draftOtherPage = makeDraft(ownerA, 'page-b', 'result-1');
    const draftOtherOwner = makeDraft(ownerB, 'page-a', 'result-1');
    draftOtherPage.config.name = 'Page B';
    draftOtherOwner.config.name = 'Other editor';

    writeCalculatedResultDraft(draftA);
    writeCalculatedResultDraft(draftOtherPage);
    writeCalculatedResultDraft(draftOtherOwner);
    draftA.config.format.precision = 99;
    draftA.bindings[0]!.start = 2;

    expect(readCalculatedResultDraft(ownerA, 'page-a', 'result-1')).toMatchObject({
      config: { name: 'Draft name', format: { precision: 4 } },
      formula: 'abc',
      bindings: [{ start: 0, end: 3, source: 'abc' }],
    });
    expect(readCalculatedResultDraft(ownerA, 'page-b', 'result-1')?.config.name).toBe('Page B');
    expect(readCalculatedResultDraft(ownerB, 'page-a', 'result-1')?.config.name).toBe('Other editor');

    const readCopy = readCalculatedResultDraft(ownerA, 'page-a', 'result-1')!;
    readCopy.config.format.precision = 88;
    readCopy.bindings[0]!.source = 'mutated';
    expect(readCalculatedResultDraft(ownerA, 'page-a', 'result-1')?.config.format.precision).toBe(4);
    expect(readCalculatedResultDraft(ownerA, 'page-a', 'result-1')?.bindings[0]?.source).toBe('abc');
  });

  it('keeps the original conflict target when attributes change under the same id', () => {
    const { editor, fake } = fakeEditor();
    const draft = makeDraft(editor, 'page-a', 'result-1');
    const originalSignature = draft.target.configSignature;
    writeCalculatedResultDraft(draft);

    const changed = attrs('page-a', 'result-1', 'Changed elsewhere');
    fake.emitTransaction(docWithResults(changed));
    const restored = readCalculatedResultDraft(editor, 'page-a', 'result-1')!;
    const newlyCapturedTarget = captureCalculatedResultEditTarget(editor, 'page-a', 'result-1', changed);
    writeCalculatedResultDraft({ ...restored, target: newlyCapturedTarget, formula: 'updated local formula' });
    const afterWrite = readCalculatedResultDraft(editor, 'page-a', 'result-1')!;

    expect(afterWrite.target.configSignature).toBe(originalSignature);
    expect(afterWrite.formula).toBe('updated local formula');
    expect(isCurrentCalculatedResultEditTarget(editor, () => 1, afterWrite.target)).toBe(false);
  });

  it('bootstraps a restored session, then uses current persisted content after Cancel and a new edit', () => {
    const { editor, fake } = fakeEditor();
    const original = makeDraft(editor, 'page-a', 'result-1');
    const restoredDraft = { ...original, formula: '42', bindings: [] };
    writeCalculatedResultDraft(restoredDraft);
    const restored = readCalculatedResultDraft(editor, 'page-a', 'result-1');
    expect(calculatedResultFormulaDraftSeed(restored, 'abc', []).source).toBe('42');

    clearCalculatedResultDraft(editor, 'page-a', 'result-1');
    const afterCancel = readCalculatedResultDraft(editor, 'page-a', 'result-1');
    expect(calculatedResultFormulaDraftSeed(afterCancel, 'abc', []).source).toBe('abc');

    const savedAttrs = { ...attrs('page-a', 'result-1'), formula: '84' };
    fake.emitTransaction(docWithResults(savedAttrs));
    const nextTarget = captureCalculatedResultEditTarget(editor, 'page-a', 'result-1', savedAttrs);
    writeCalculatedResultDraft({ ...original, target: nextTarget, formula: '84', bindings: [] });
    const nextSession = readCalculatedResultDraft(editor, 'page-a', 'result-1');
    expect(calculatedResultFormulaDraftSeed(nextSession, '84', []).source).toBe('84');
  });

  it('saves against the remounted position without replacing neighboring structure or text', () => {
    const originalAttrs = attrs('page-a', 'result-1');
    const synchronizedDoc = schema.node('doc', null, [
      schema.node('paragraph'),
      schema.node('paragraph', null, [
        schema.text('XBefore sync '),
        schema.node('calculatedResult', originalAttrs),
        schema.text(' after sync'),
      ]),
    ]);
    let resultPosition = -1;
    synchronizedDoc.descendants((node, position) => {
      if (node.type.name === 'calculatedResult') resultPosition = position;
    });
    const { editor: owner, fake } = fakeEditor(synchronizedDoc);
    writeCalculatedResultDraft(makeDraft(owner, 'page-a', 'result-1'));
    const restored = readCalculatedResultDraft(owner, 'page-a', 'result-1')!;
    const targetEditorState = EditorState.create({ schema, doc: synchronizedDoc });
    const currentNode = targetEditorState.doc.nodeAt(resultPosition)!;

    fake.emitTransaction(synchronizedDoc);

    expect(isCurrentCalculatedResultEditTarget(owner, () => resultPosition, restored.target)).toBe(true);
    const savedState = targetEditorState.apply(createCalculatedResultConfigurationTransaction(
      targetEditorState.tr,
      resultPosition,
      currentNode,
      { ...currentNode.attrs, name: 'Saved name', formula: '42' },
    ));
    expect(savedState.doc.childCount).toBe(2);
    expect(savedState.doc.child(0).content.size).toBe(0);
    expect(savedState.doc.child(1).textContent).toBe('XBefore sync  after sync');
    expect(savedState.doc.child(1).child(1)?.attrs).toMatchObject({
      resultId: 'result-1',
      name: 'Saved name',
      formula: '42',
    });
  });

  it('clears only the session whose result is actually absent from the updated document', () => {
    const { editor, fake } = fakeEditor(docWithResults(attrs('page-a', 'result-1'), attrs('page-b', 'result-1')));
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-1'));
    writeCalculatedResultDraft(makeDraft(editor, 'page-b', 'result-1'));

    fake.emitTransaction(docWithResults(attrs('page-b', 'result-1')));

    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')).toBeNull();
    expect(readCalculatedResultDraft(editor, 'page-b', 'result-1')).not.toBeNull();
  });

  it('does not let a late formula callback recreate a session after real deletion', () => {
    const { editor, fake } = fakeEditor(docWithResults(attrs('page-a', 'result-1'), attrs('page-a', 'result-2')));
    const deletedDraft = makeDraft(editor, 'page-a', 'result-1');
    writeCalculatedResultDraft(deletedDraft);
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-2'));

    fake.emitTransaction(docWithResults(attrs('page-a', 'result-2')));
    writeCalculatedResultDraft(deletedDraft);

    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')).toBeNull();
    expect(readCalculatedResultDraft(editor, 'page-a', 'result-2')).not.toBeNull();
  });

  it('observes target deletion by an appended transaction', () => {
    const { editor, fake } = fakeEditor();
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-1'));

    fake.emitTransaction(schema.node('doc', null, [schema.node('paragraph')]), false, [{ docChanged: true }]);

    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')).toBeNull();
  });

  it('keeps a readonly owner session available for a disabled restored form and lets Cancel clear it', () => {
    const { editor, fake } = fakeEditor();
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-1'));
    fake.isEditable = false;

    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')?.formula).toBe('abc');
    clearCalculatedResultDraft(editor, 'page-a', 'result-1');
    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')).toBeNull();
  });

  it('clears all remaining sessions and detaches on owner destruction', () => {
    const { editor, fake } = fakeEditor(docWithResults(attrs('page-a', 'result-1'), attrs('page-b', 'result-2')));
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-1'));
    writeCalculatedResultDraft(makeDraft(editor, 'page-b', 'result-2'));
    expect(fake.listenerCount('transaction')).toBe(1);
    expect(fake.listenerCount('destroy')).toBe(1);

    fake.destroy();

    expect(readCalculatedResultDraft(editor, 'page-a', 'result-1')).toBeNull();
    expect(readCalculatedResultDraft(editor, 'page-b', 'result-2')).toBeNull();
    expect(fake.listenerCount('transaction')).toBe(0);
    expect(fake.listenerCount('destroy')).toBe(0);
  });

  it('detaches owner listeners as soon as the final draft is cleared', () => {
    const { editor, fake } = fakeEditor();
    writeCalculatedResultDraft(makeDraft(editor, 'page-a', 'result-1'));

    clearCalculatedResultDraft(editor, 'page-a', 'result-1');

    expect(fake.listenerCount('transaction')).toBe(0);
    expect(fake.listenerCount('destroy')).toBe(0);
  });
});
