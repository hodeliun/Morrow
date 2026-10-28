import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from '../i18n';

export const sectionFoldingKey = new PluginKey<DecorationSet>('sectionFolding');

function findFoldingDecorations(doc: ProsemirrorNode): Decoration[] {
  const decos: Decoration[] = [];

  function scanContainer(container: ProsemirrorNode, containerOffset: number) {
    let activeHeadingLevel: number | null = null;

    container.forEach((child, offset) => {
      const childPos = containerOffset + offset;

      if (child.type.name === 'heading') {
        const level = Number(child.attrs.level) || 1;
        if (activeHeadingLevel !== null && level <= activeHeadingLevel) {
          activeHeadingLevel = null;
        }

        if (child.attrs.collapsible) {
          decos.push(
            Decoration.widget(
              childPos + 1,
              (view) => {
                const isCollapsed = Boolean(child.attrs.collapsed);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `heading-fold-btn${isCollapsed ? ' is-collapsed' : ' is-expanded'}`;
                btn.setAttribute('aria-expanded', String(!isCollapsed));
                btn.setAttribute(
                  'aria-label',
                  isCollapsed ? t('editor.unfoldSection') : t('editor.foldSection'),
                );
                btn.title = isCollapsed ? t('editor.unfoldSection') : t('editor.foldSection');
                btn.contentEditable = 'false';
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="heading-fold-icon"><path d="m9 18 6-6-6-6"/></svg>`;

                btn.addEventListener('mousedown', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                });

                btn.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const node = view.state.doc.nodeAt(childPos);
                  if (!node) return;
                  const nextCollapsed = !node.attrs.collapsed;
                  let tr = view.state.tr.setNodeMarkup(childPos, undefined, {
                    ...node.attrs,
                    collapsed: nextCollapsed,
                  });
                  if (
                    nextCollapsed &&
                    view.state.selection.from > childPos &&
                    view.state.selection.to <= childPos + child.nodeSize
                  ) {
                    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(childPos + 1)));
                  }
                  view.dispatch(tr);
                });

                return btn;
              },
              { side: -1, stopEvent: () => true },
            ),
          );
        }

        if (activeHeadingLevel !== null) {
          decos.push(
            Decoration.node(childPos, childPos + child.nodeSize, {
              class: 'is-collapsed-hidden',
            }),
          );
        } else if (child.attrs.collapsible && child.attrs.collapsed) {
          activeHeadingLevel = level;
        }
      } else {
        if (activeHeadingLevel !== null) {
          decos.push(
            Decoration.node(childPos, childPos + child.nodeSize, {
              class: 'is-collapsed-hidden',
            }),
          );
        }
      }

      if (child.isBlock && !child.isTextblock && child.childCount > 0) {
        scanContainer(child, childPos + 1);
      }
    });
  }

  scanContainer(doc, 0);
  return decos;
}

export function revealAncestorsForPosition(view: EditorView, targetPos: number): boolean {
  if (targetPos < 0 || targetPos > view.state.doc.content.size) return false;
  const $pos = view.state.doc.resolve(targetPos);
  let changed = false;
  let tr = view.state.tr;

  for (let depth = $pos.depth; depth >= 0; depth--) {
    const container = $pos.node(depth);
    const containerStart = $pos.start(depth);

    const headings: Array<{ pos: number; level: number; collapsed: boolean }> = [];

    container.forEach((child, offset) => {
      const p = containerStart + offset;
      if (child.type.name === 'heading') {
        headings.push({
          pos: p,
          level: Number(child.attrs.level) || 1,
          collapsed: Boolean(child.attrs.collapsible && child.attrs.collapsed),
        });
      }
    });

    for (const h of headings) {
      if (h.pos < targetPos && h.collapsed) {
        const closedBeforeTarget = headings.some(
          (h2) => h2.pos > h.pos && h2.pos <= targetPos && h2.level <= h.level,
        );
        if (!closedBeforeTarget) {
          const node = view.state.doc.nodeAt(h.pos);
          if (node && node.attrs.collapsible && node.attrs.collapsed) {
            tr = tr.setNodeMarkup(h.pos, undefined, { ...node.attrs, collapsed: false });
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    view.dispatch(tr);
    return true;
  }
  return false;
}

export const CollapsibleHeading = Extension.create({
  name: 'collapsibleHeading',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          collapsible: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-collapsible') === 'true',
            renderHTML: (attrs) => (attrs.collapsible ? { 'data-collapsible': 'true' } : {}),
          },
          collapsed: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
            renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: sectionFoldingKey,
        state: {
          init(_, { doc }) {
            return DecorationSet.create(doc, findFoldingDecorations(doc));
          },
          apply(tr, oldSet, _oldState, newState) {
            if (tr.docChanged || tr.steps.some((s) => s.toJSON()?.stepType === 'setNodeMarkup')) {
              return DecorationSet.create(newState.doc, findFoldingDecorations(newState.doc));
            }
            return oldSet.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return sectionFoldingKey.getState(state);
          },
        },
      }),
    ];
  },
});
