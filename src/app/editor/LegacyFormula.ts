import { Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  LEGACY_FORMULA_NODE,
  legacyFormulaDocIssue,
  parseLegacyFormulaPresentation,
} from '../../core/legacyFormula';
import { getLocale } from '../i18n';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { polarisDadosInlineFormulaPresentation, subscribeInlineFormulaPresentation } from '../plugins/registry';

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
      const presentationContainer = document.createElement('span');
      presentationContainer.className = 'legacy-formula-presentation';
      dom.append(presentationContainer);

      let raw = String(node.attrs.raw ?? '');
      let fallback = String(node.attrs.fallback ?? '');
      let removePresentation: (() => void) | null = null;
      let currentLocale = getLocale();

      const restoreFallback = () => {
        const cleanup = removePresentation;
        removePresentation = null;
        try {
          cleanup?.();
        } catch {
          // A plugin cleanup must not prevent the host from restoring its inert source text.
        } finally {
          presentationContainer.replaceChildren();
          presentationContainer.className = 'legacy-formula-presentation';
          for (const attribute of [...presentationContainer.attributes]) {
            if (attribute.name !== 'class')
              presentationContainer.removeAttribute(attribute.name);
          }
          presentationContainer.textContent = fallback;
        }
      };

      const present = () => {
        restoreFallback();
        const payload = parseLegacyFormulaPresentation(raw, fallback);
        const registration = polarisDadosInlineFormulaPresentation();
        if (!payload || !registration?.isActive()) return;

        const context = Object.freeze({
          ...payload,
          format: payload.format ? Object.freeze({ ...payload.format }) : null,
          locale: getLocale(),
        });
        try {
          const cleanup = registration.mount(presentationContainer, context);
          if (typeof cleanup === 'function') removePresentation = cleanup;
        } catch {
          restoreFallback();
          presentationContainer.setAttribute('role', 'status');
          presentationContainer.setAttribute('aria-label', `${fallback}: formula presentation unavailable`);
        }
      };

      const unsubscribePresentation = subscribeInlineFormulaPresentation(present);
      const unsubscribePreferences = subscribePreferences(() => {
        const nextLocale = getPreferences().locale;
        if (nextLocale === currentLocale) return;
        currentLocale = nextLocale;
        present();
      });

      const update = (next: ProseMirrorNode) => {
        raw = String(next.attrs.raw ?? '');
        fallback = String(next.attrs.fallback ?? '');
        present();
      };
      update(node);

      return {
        dom,
        update(next) {
          if (next.type !== node.type) return false;
          update(next);
          return true;
        },
        destroy() {
          unsubscribePresentation();
          unsubscribePreferences();
          restoreFallback();
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
