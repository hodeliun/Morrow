import { Extension } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { t } from '../i18n';

interface SectionFoldingState {
  decorations: DecorationSet;
  collapsedOverrides: ReadonlyMap<number, boolean>;
}

type SectionFoldingMeta =
  | { type: 'reveal'; positions: number[] }
  | { type: 'set-collapsed'; position: number; collapsed: boolean }
  | { type: 'clear-collapsed'; position: number }
  | { type: 'reset' };

export const sectionFoldingKey = new PluginKey<SectionFoldingState>('sectionFolding');
const TABLE_TOGGLE_TITLES = new Set(['Table', 'Tabela', 'Tabla']);

export const TableToggleMarker = Extension.create({
  name: 'tableToggleMarker',
  addGlobalAttributes() {
    return [
      {
        types: ['details'],
        attributes: {
          tableToggleTitle: {
            default: null,
            parseHTML: (element) => {
              const title = element.getAttribute('data-morrow-table-toggle');
              return title && TABLE_TOGGLE_TITLES.has(title) ? title : null;
            },
            renderHTML: (attrs) =>
              typeof attrs.tableToggleTitle === 'string' && TABLE_TOGGLE_TITLES.has(attrs.tableToggleTitle)
                ? { 'data-morrow-table-toggle': attrs.tableToggleTitle }
                : {},
          },
        },
      },
    ];
  },
});

export function setHeadingCollapsible(tr: Transaction, position: number, enabled: boolean): boolean {
  const node = tr.doc.nodeAt(position);
  if (!node || node.type.name !== 'heading') return false;
  tr.setNodeMarkup(position, undefined, {
    ...node.attrs,
    collapsible: enabled,
    collapsed: false,
  });
  return true;
}

export function wrapBlockInDetails(
  tr: Transaction,
  position: number,
  summaryContent: Fragment,
  bodyContent: Fragment,
  summaryAttrs: Record<string, unknown> = {},
  options: { tableToggleTitle?: string } = {},
): boolean {
  const source = tr.doc.nodeAt(position);
  const { details, detailsSummary, detailsContent } = tr.doc.type.schema.nodes;
  if (!source || !details || !detailsSummary || !detailsContent) return false;
  const summary = detailsSummary.create(summaryAttrs, summaryContent);
  const content = detailsContent.create(null, bodyContent);
  const blockId = source.attrs.blockId;
  const toggle = details.create(
    {
      open: true,
      ...(typeof blockId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(blockId) ? { blockId } : {}),
      ...(options.tableToggleTitle && TABLE_TOGGLE_TITLES.has(options.tableToggleTitle)
        ? { tableToggleTitle: options.tableToggleTitle }
        : {}),
    },
    [summary, content],
  );
  tr.replaceWith(position, position + source.nodeSize, toggle);
  return true;
}

export function isTableToggle(node: ProsemirrorNode | null | undefined): boolean {
  if (
    !node ||
    node.type.name !== 'details' ||
    node.childCount !== 2 ||
    node.child(1).childCount !== 1 ||
    node.child(1).child(0).type.name !== 'table'
  )
    return false;
  return typeof node.attrs.tableToggleTitle === 'string' && TABLE_TOGGLE_TITLES.has(node.attrs.tableToggleTitle);
}

function hasUneditedSyntheticTableTitle(node: ProsemirrorNode): boolean {
  const summary = node.child(0);
  const title = node.attrs.tableToggleTitle;
  return (
    typeof title === 'string' &&
    TABLE_TOGGLE_TITLES.has(title) &&
    summary.attrs.blockBackground == null &&
    summary.childCount === 1 &&
    summary.child(0).isText &&
    summary.child(0).text === title &&
    summary.child(0).marks.length === 0
  );
}

export function unwrapDetailsToParagraph(tr: Transaction, position: number): boolean {
  const toggle = tr.doc.nodeAt(position);
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  if (!toggle || toggle.type.name !== 'details' || toggle.childCount < 2 || !paragraph) return false;
  const summary = toggle.child(0);
  const folded = toggle.child(1);
  const wrapperBlockId = toggle.attrs.blockId;
  if (isTableToggle(toggle) && hasUneditedSyntheticTableTitle(toggle)) {
    tr.replaceWith(position, position + toggle.nodeSize, folded.child(0));
    return true;
  }
  const attrs: Record<string, unknown> = {};
  if (summary.attrs.blockBackground !== undefined) attrs.blockBackground = summary.attrs.blockBackground;
  if (typeof wrapperBlockId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(wrapperBlockId))
    attrs.blockId = wrapperBlockId;
  const blocks = Array.from(folded.content.content);
  const first = blocks[0];
  let transferredBlockId = false;
  if (
    first?.type.name === 'paragraph' &&
    typeof first.attrs.blockId === 'string' &&
    /^[A-Za-z0-9-]{1,64}$/.test(first.attrs.blockId) &&
    (attrs.blockId === undefined || attrs.blockId === first.attrs.blockId)
  ) {
    transferredBlockId = true;
    if (attrs.blockId === undefined) attrs.blockId = first.attrs.blockId;
    blocks[0] = first.type.create({ ...first.attrs, blockId: null }, first.content, first.marks);
  }
  if (
    blocks[0]?.type.name === 'paragraph' &&
    !blocks[0].content.size &&
    (blocks.length === 1 || transferredBlockId)
  )
    blocks.shift();
  const title = paragraph.create(attrs, summary.content, summary.marks);
  tr.replaceWith(position, position + toggle.nodeSize, Fragment.fromArray([title, ...blocks]));
  return true;
}

function isHeadingCollapsed(
  node: ProsemirrorNode,
  position: number,
  overrides: ReadonlyMap<number, boolean>,
): boolean {
  if (!node.attrs.collapsible) return false;
  return overrides.has(position) ? overrides.get(position) === true : Boolean(node.attrs.collapsed);
}

function findFoldingDecorations(doc: ProsemirrorNode, overrides: ReadonlyMap<number, boolean>): Decoration[] {
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
                const node = view.state.doc.nodeAt(childPos) ?? child;
                const currentOverrides =
                  sectionFoldingKey.getState(view.state)?.collapsedOverrides ?? overrides;
                const isCollapsed = isHeadingCollapsed(node, childPos, currentOverrides);
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
                  toggleSectionCollapsed(view, childPos);
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
        } else if (isHeadingCollapsed(child, childPos, overrides)) {
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

export function toggleSectionCollapsed(view: EditorView, position: number): void {
  const node = view.state.doc.nodeAt(position);
  if (!node || node.type.name !== 'heading' || !node.attrs.collapsible) return;
  const overrides = sectionFoldingKey.getState(view.state)?.collapsedOverrides ?? new Map();
  const nextCollapsed = !isHeadingCollapsed(node, position, overrides);

  if (!view.editable) {
    view.dispatch(
      view.state.tr.setMeta(sectionFoldingKey, {
        type: 'set-collapsed',
        position,
        collapsed: nextCollapsed,
      } satisfies SectionFoldingMeta),
    );
    return;
  }

  let tr = view.state.tr.setNodeMarkup(position, undefined, {
    ...node.attrs,
    collapsed: nextCollapsed,
  });
  if (
    nextCollapsed &&
    view.state.selection.from > position &&
    view.state.selection.to <= position + node.nodeSize
  ) {
    tr = tr.setSelection(TextSelection.near(tr.doc.resolve(position + 1)));
  }
  view.dispatch(
    tr.setMeta(sectionFoldingKey, { type: 'clear-collapsed', position } satisfies SectionFoldingMeta),
  );
}

export function createSectionFoldingPlugin(): Plugin {
  return new Plugin({
    key: sectionFoldingKey,
    state: {
      init(_, { doc }) {
        const collapsedOverrides = new Map<number, boolean>();
        return {
          collapsedOverrides,
          decorations: DecorationSet.create(doc, findFoldingDecorations(doc, collapsedOverrides)),
        };
      },
      apply(tr, oldState, _oldEditorState, newState) {
        const meta = tr.getMeta(sectionFoldingKey) as SectionFoldingMeta | undefined;
        let collapsedOverrides = oldState.collapsedOverrides;

        if (tr.docChanged) {
          const mappedOverrides = new Map<number, boolean>();
          for (const [position, collapsed] of collapsedOverrides) {
            const mapped = tr.mapping.mapResult(position, 1);
            if (mapped.deleted) continue;
            const node = newState.doc.nodeAt(mapped.pos);
            if (node?.type.name === 'heading' && node.attrs.collapsible) {
              mappedOverrides.set(mapped.pos, collapsed);
            }
          }
          collapsedOverrides = mappedOverrides;
        }
        if (meta?.type === 'reveal') {
          const nextOverrides = new Map(collapsedOverrides);
          for (const position of meta.positions) nextOverrides.set(position, false);
          collapsedOverrides = nextOverrides;
        } else if (meta?.type === 'set-collapsed') {
          const nextOverrides = new Map(collapsedOverrides);
          nextOverrides.set(meta.position, meta.collapsed);
          collapsedOverrides = nextOverrides;
        } else if (meta?.type === 'clear-collapsed') {
          const nextOverrides = new Map(collapsedOverrides);
          nextOverrides.delete(tr.mapping.map(meta.position, 1));
          collapsedOverrides = nextOverrides;
        } else if (meta?.type === 'reset') collapsedOverrides = new Map();

        if (tr.docChanged || meta || tr.steps.some((step) => step.toJSON()?.stepType === 'setNodeMarkup')) {
          return {
            collapsedOverrides,
            decorations: DecorationSet.create(
              newState.doc,
              findFoldingDecorations(newState.doc, collapsedOverrides),
            ),
          };
        }
        return {
          collapsedOverrides,
          decorations: oldState.decorations.map(tr.mapping, tr.doc),
        };
      },
    },
    props: {
      decorations(state) {
        return sectionFoldingKey.getState(state)?.decorations;
      },
    },
  });
}

export function revealAncestorsForPosition(view: EditorView, targetPos: number): boolean {
  if (targetPos < 0 || targetPos > view.state.doc.content.size) return false;
  const $pos = view.state.doc.resolve(targetPos);
  let changed = false;
  const collapsedOverrides = sectionFoldingKey.getState(view.state)?.collapsedOverrides ?? new Map();
  const temporaryRevealPositions: number[] = [];

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
          collapsed: isHeadingCollapsed(child, p, collapsedOverrides),
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
          if (node && node.attrs.collapsible && h.collapsed) {
            temporaryRevealPositions.push(h.pos);
            changed = true;
          }
        }
      }
    }
  }

  if (changed) {
    view.dispatch(
      view.state.tr.setMeta(sectionFoldingKey, {
        type: 'reveal',
        positions: temporaryRevealPositions,
      } satisfies SectionFoldingMeta),
    );
    return true;
  }
  return false;
}

export function resetTemporaryFolding(view: EditorView): void {
  const overrides = sectionFoldingKey.getState(view.state)?.collapsedOverrides;
  if (!overrides?.size) return;
  view.dispatch(view.state.tr.setMeta(sectionFoldingKey, { type: 'reset' } satisfies SectionFoldingMeta));
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
    return [createSectionFoldingPlugin()];
  },
});
