import { Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { LEGACY_FORMULA_NODE, legacyFormulaDocIssue } from '../../core/legacyFormula';

/** Keeps old result spans readable without evaluating them or exposing their identity to clipboard HTML. */
export const LegacyFormula = Node.create({
  name: LEGACY_FORMULA_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  marks: '_',

  addAttributes() {
    return {
      raw: { default: '' },
      fallback: { default: '' },
    };
  },

  parseHTML() {
    return [];
  },

  renderHTML({ node }) {
    return [
      'span',
      { class: 'legacy-formula-fallback', contenteditable: 'false' },
      String(node.attrs.fallback ?? ''),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.fallback ?? '');
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'legacy-formula-fallback';
      dom.contentEditable = 'false';

      const update = (next: ProseMirrorNode) => {
        dom.textContent = String(next.attrs.fallback ?? '');
      };
      update(node);

      return {
        dom,
        update(next) {
          if (next.type !== node.type) return false;
          update(next);
          return true;
        },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction(transaction) {
          if (!transaction.docChanged) return true;
          return !legacyFormulaDocIssue(transaction.doc.toJSON());
        },
        appendTransaction(_transactions, oldState, newState) {
          const marksByRaw = new Map<string, ProseMirrorNode['marks']>();
          oldState.doc.descendants((node) => {
            if (node.type.name !== LEGACY_FORMULA_NODE || typeof node.attrs.raw !== 'string') return;
            if (!marksByRaw.has(node.attrs.raw)) marksByRaw.set(node.attrs.raw, node.marks);
          });

          const transaction = newState.tr;
          newState.doc.descendants((node, position) => {
            if (node.type.name !== LEGACY_FORMULA_NODE || typeof node.attrs.raw !== 'string') return;
            const previousMarks = marksByRaw.get(node.attrs.raw) ?? [];
            if (sameMarks(node.marks, previousMarks)) return;
            transaction.setNodeMarkup(position, undefined, node.attrs, previousMarks);
          });
          return transaction.docChanged ? transaction : null;
        },
      }),
    ];
  },
});

function sameMarks(left: ProseMirrorNode['marks'], right: ProseMirrorNode['marks']): boolean {
  return left.length === right.length && left.every((mark, index) => mark.eq(right[index]!));
}
