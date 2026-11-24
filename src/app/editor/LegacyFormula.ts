import { Node } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  LEGACY_FORMULA_NODE,
  legacyFormulaDocIssue,
  parseEditableLegacyFormula,
  parseLegacyFormulaPresentation,
} from '../../core/legacyFormula';
import { getLocale } from '../i18n';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { pageEditorInsertionPeerFor, subscribePageEditorInsertionPeer } from './pageEditorCoordination';
import { polarisDadosInlineFormulaPresentation, subscribeInlineFormulaPresentation } from '../plugins/registry';
import { captureInlineFormulaEditTarget } from '../plugins/inlineFormulaEditTarget';
import type { EditorInsertionOwner } from './editorInsertion';

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
    const editor = this.editor;
    return ({ node, getPos }) => {
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
      let currentReadingMode = getPreferences().readingMode;

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
          ...(registration.onEdit ? (() => {
            const position = (): number | null => {
              try {
                const value = getPos();
                return typeof value === 'number' ? value : null;
              } catch {
                return null;
              }
            };
            const owner: EditorInsertionOwner = {
              generation: registration.generation,
              isActive: registration.isActive,
            };
            const initialPosition = position();
            if (
              initialPosition === null ||
              !hasEditableFormulaNode(editor, initialPosition, raw, fallback)
            ) return {};
            return {
              onEdit: () => {
                if (!registration.isActive()) return;
                const currentPosition = position();
                if (currentPosition === null) return;
                const host = captureInlineFormulaEditTarget(owner, editor, currentPosition, raw, fallback);
                if (!host) return;
                try {
                  registration.onEdit?.(host);
                } catch {
                  host.cancel();
                }
              },
            };
          })() : {}),
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
        const preferences = getPreferences();
        if (preferences.locale === currentLocale && preferences.readingMode === currentReadingMode) return;
        currentLocale = preferences.locale;
        currentReadingMode = preferences.readingMode;
        present();
      });
      const peer = pageEditorInsertionPeerFor(editor);
      const unsubscribePeer = peer
        ? subscribePageEditorInsertionPeer(editor, peer, present)
        : () => {};

      const update = (next: ProseMirrorNode) => {
        raw = String(next.attrs.raw ?? '');
        fallback = String(next.attrs.fallback ?? '');
        present();
      };
      update(node);

      return {
        dom,
        stopEvent(event) {
          const ElementType = dom.ownerDocument.defaultView?.Element;
          if (!ElementType || !(event.target instanceof ElementType)) return false;
          const editButton = event.target.closest('button.inline-formula-edit-action');
          return Boolean(editButton && presentationContainer.contains(editButton));
        },
        update(next) {
          if (next.type !== node.type) return false;
          update(next);
          return true;
        },
        destroy() {
          unsubscribePresentation();
          unsubscribePreferences();
          unsubscribePeer();
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

function hasEditableFormulaNode(editor: Editor, position: number, raw: string, fallback: string): boolean {
  try {
    const node = editor.state.doc.nodeAt(position);
    const resolved = editor.state.doc.resolve(position);
    const marker = parseEditableLegacyFormula(raw, fallback);
    return Boolean(
      editor.isEditable && !getPreferences().readingMode && node?.type.name === LEGACY_FORMULA_NODE &&
      node.attrs.raw === raw && node.attrs.fallback === fallback && marker &&
      resolved.depth === 1 && resolved.parent.type.name === 'paragraph' &&
      resolved.node(0).type.name === 'doc' && legacyFormulaDocIssue(editor.getJSON()) === null,
    );
  } catch {
    return false;
  }
}

function sameMarks(left: ProseMirrorNode['marks'], right: ProseMirrorNode['marks']): boolean {
  return left.length === right.length && left.every((mark, index) => mark.eq(right[index]!));
}
