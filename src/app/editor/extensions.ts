import { Extension, InputRule, isAtEndOfNode, resolveFocusPosition, wrappingInputRule } from '@tiptap/core';
import type { AnyExtension, Editor } from '@tiptap/core';
import { Blockquote } from '@tiptap/extension-blockquote';
import { Code } from '@tiptap/extension-code';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { listHelpers, TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { t } from '../i18n';
import { normalizeInlineColor } from '../../core/model';
import { BlockHandle } from './BlockHandle';
import { BlockSelect } from './BlockSelect';
import { Callout, FindReplace } from './Blocks';
import { PasteMenu } from './PasteMenu';
import { ClickBelow } from './ClickBelow';
import { EmojiSuggest } from './EmojiSuggest';
import { CodeBlock, Highlight, mathExtensions, MathViewTracker, RawBlock, Tags, TextColor } from './Extras';
import { FileAttachment, FileDrop, Image } from './Media';
import { LegacyFormula } from './LegacyFormula';
import type { BlockMenuRequest } from './BlockHandle';
import { CopyFromInside, MarkdownPaste, PasteOnEmptyLine } from './MarkdownPaste';
import { MultiSelect } from './MultiSelect';
import { ColumnGrip } from './ColumnGrip';
import { CustomEmojiText } from './CustomEmojiText';
import { PageLink } from './PageLink';
import type { PageLinkOptions } from './PageLink';
import { PolarisDadosView } from './PolarisDadosView';
import type { PolarisDadosViewMountContext } from './PolarisDadosView';
import { SlashCommand } from './SlashCommand';
import { canTurnListItem, IndentedLines, KeepTab, lineContent, LineEdges, turnListItem } from './turnInto';
import { joinBackward, joinForward, lift } from '@tiptap/pm/commands';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { joinPoint, ReplaceAroundStep } from '@tiptap/pm/transform';
import { isHexBlockBackground, supportsHexBlockBackgroundOwner } from '../../core/markdown/blockBackground';
import { Column, Columns, DateMention, TableOfContents } from './Structure';

export interface ExtensionOptions extends PageLinkOptions {
  linkedViewContext?: PolarisDadosViewMountContext;
  onBlockMenu: (request: BlockMenuRequest) => void;
  resolvePage: (title: string) => string | null;
  openTag: (tag: string) => void;
  createChild: (kind: 'database' | 'canvas') => string | null;
  openDate: (date: Date) => void;
  dateMenu?: (date: Date, anchor: HTMLElement, time: string | null) => void;
}

// obsidian block ids live on paragraphs and are written back as " ^id". pressing enter at the end of one
// never hands its id to the new paragraph
const BlockIds = Extension.create({
  name: 'blockIds',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIdsPaste'),
        props: {
          transformPasted: (slice, view) => {
            const taken = new Set<string>();
            view.state.doc.descendants((node) => {
              if (typeof node.attrs.blockId === 'string' && node.attrs.blockId) taken.add(node.attrs.blockId);
            });
            if (!taken.size) return slice;
            const strip = (fragment: Fragment): Fragment => {
              const children: PMNode[] = [];
              fragment.forEach((child) => {
                const id = child.attrs.blockId;
                const attrs =
                  typeof id === 'string' && taken.has(id) ? { ...child.attrs, blockId: null } : child.attrs;
                children.push(
                  child.isText ? child : child.type.create(attrs, strip(child.content), child.marks),
                );
              });
              return Fragment.from(children);
            };
            return new Slice(strip(slice.content), slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            // a pasted copy of a block on the same page leaves its ^id behind, links go to the original
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
    ];
  },
});

// a line with another page shown in it can leave out that page's title, just its words show
const EmbedTitle = Extension.create({
  name: 'embedTitle',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: {
          embedTitle: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => (element.getAttribute('data-embed-title') === 'hidden' ? false : null),
            renderHTML: (attrs) => (attrs.embedTitle === false ? { 'data-embed-title': 'hidden' } : {}),
          },
        },
      },
    ];
  },
});

// an html code block can be drawn as a page beside its code, see the code block in Extras.ts
const CodePreview = Extension.create({
  name: 'codePreview',
  addGlobalAttributes() {
    return [
      {
        types: ['codeBlock'],
        attributes: {
          preview: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element) => (element.getAttribute('data-preview') === 'true' ? true : null),
            renderHTML: (attrs) => (attrs.preview === true ? { 'data-preview': 'true' } : {}),
          },
        },
      },
    ];
  },
});

// a block's own background colour, from the colour in its Turn into menu
function unsupportedCustomBlockBackgrounds(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: PMNode, ancestors: string[], firstTaskItemParagraph = false) => {
    const backgroundColor = normalizeInlineColor(node.attrs.backgroundColor);
    const ambiguousTaskFirstParagraph =
      node.type.name === 'paragraph' && firstTaskItemParagraph && backgroundColor !== null;
    if (
      ambiguousTaskFirstParagraph ||
      (isHexBlockBackground(backgroundColor) &&
        !supportsHexBlockBackgroundOwner(node.type.name, ancestors, firstTaskItemParagraph))
    ) {
      const signature = JSON.stringify([backgroundColor, node.type.name, ancestors, firstTaskItemParagraph]);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    node.forEach((child, _offset, index) =>
      visit(child, [...ancestors, node.type.name], node.type.name === 'taskItem' && index === 0),
    );
  };
  visit(doc, []);
  return counts;
}

function introducesUnsupportedCustomBlockBackground(oldDoc: PMNode, newDoc: PMNode): boolean {
  const previous = unsupportedCustomBlockBackgrounds(oldDoc);
  for (const [signature, count] of unsupportedCustomBlockBackgrounds(newDoc))
    if (count > (previous.get(signature) ?? 0)) return true;
  return false;
}

function fragmentHasBlockBackground(fragment: Fragment): boolean {
  let found = false;
  fragment.forEach((node) => {
    if (found) return;
    if (normalizeInlineColor(node.attrs.backgroundColor) || fragmentHasBlockBackground(node.content))
      found = true;
  });
  return found;
}

function listItemHasParagraphBackgroundAt(doc: PMNode, position: number): boolean {
  const safePosition = Math.max(0, Math.min(position, doc.content.size));
  const $position = doc.resolve(safePosition);
  for (let depth = $position.depth; depth > 0; depth--) {
    const item = $position.node(depth);
    if (item.type.name !== 'listItem' && item.type.name !== 'taskItem') continue;
    let found = false;
    item.descendants((node) => {
      if (node.type.name === 'paragraph' && normalizeInlineColor(node.attrs.backgroundColor)) {
        found = true;
        return false;
      }
    });
    if (found) return true;
  }
  return false;
}

function listItemHasConflictingBackgrounds(item: PMNode): boolean {
  const itemBackground = normalizeInlineColor(item.attrs.backgroundColor);
  if (!itemBackground) return false;
  const first = item.firstChild;
  if (first?.type.name !== 'paragraph') return false;
  const firstBackground = normalizeInlineColor(first.attrs.backgroundColor);
  if (firstBackground !== null) return firstBackground !== itemBackground;
  let laterParagraphBackground = false;
  item.forEach((child, _offset, index) => {
    if (
      index > 0 &&
      child.type.name === 'paragraph' &&
      normalizeInlineColor(child.attrs.backgroundColor) !== null
    ) {
      laterParagraphBackground = true;
    }
  });
  return laterParagraphBackground;
}

function listItemHasHexParagraphBackground(item: PMNode): boolean {
  if (isHexBlockBackground(normalizeInlineColor(item.attrs.backgroundColor))) return true;
  let found = false;
  item.forEach((child) => {
    if (
      child.type.name === 'paragraph' &&
      isHexBlockBackground(normalizeInlineColor(child.attrs.backgroundColor))
    ) {
      found = true;
    }
  });
  return found;
}

const BLOCK_LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

function isIndentedLinesDeleteCandidate(state: EditorState): boolean {
  const { selection, doc } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
  if ($from.depth > 0 && ['listItem', 'taskItem'].includes($from.node(-1).type.name)) return false;
  const next = doc.resolve($from.after()).nodeAfter;
  return next !== null && BLOCK_LIST_TYPES.has(next.type.name);
}

function backgroundSensitiveDeleteBeforeList(editor: Editor, view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
  const parent = $from.node($from.depth - 1);
  if (parent.type.name === 'listItem' || parent.type.name === 'taskItem') return false;

  // IndentedLines.Delete consumes an empty line by deleting only that line. Do not preflight a
  // speculative join of the list behind it.
  if ($from.parent.content.size === 0) return false;

  // IndentedLines.Delete first lifts this item to a paragraph, then joins it to the current line.
  // Preflight the same conversion and block only when that join would discard a HEX-owned color.
  const listPosition = $from.after();
  const next = doc.resolve(listPosition).nodeAfter;
  if (!next || !BLOCK_LIST_TYPES.has(next.type.name)) return false;
  const item = next.firstChild;
  const first = item?.firstChild;
  if (
    !item ||
    (item.type.name !== 'listItem' && item.type.name !== 'taskItem') ||
    !first?.isTextblock
  ) {
    return false;
  }

  const firstBackground = normalizeInlineColor(first.attrs.backgroundColor);
  const itemBackground = normalizeInlineColor(item.attrs.backgroundColor);
  const hasHexBackground = listItemHasHexParagraphBackground(item);
  const currentBackground = normalizeInlineColor($from.parent.attrs.backgroundColor);

  // A dual first paragraph cannot use the normal turn-into path; StarterKit may handle the key instead.
  // Stop that fallback before it drops either owner when a HEX marker is involved.
  if (
    hasHexBackground &&
    firstBackground !== null &&
    itemBackground !== null &&
    firstBackground !== itemBackground
  ) {
    return true;
  }
  if (!canTurnListItem(editor, listPosition + 1, { kind: 'paragraph' })) return false;

  const liftedBackground = firstBackground ?? itemBackground;
  return (
    liftedBackground !== null &&
    hasHexBackground &&
    liftedBackground !== currentBackground
  );
}

function backgroundCounts(doc: PMNode): Map<string, number> {
  const counts = new Map<string, number>();
  doc.descendants((node) => {
    const color = normalizeInlineColor(node.attrs.backgroundColor);
    if (color === null) return;
    const key = JSON.stringify([node.type.name, color]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return counts;
}

function losesBlockBackground(before: PMNode, after: PMNode): boolean {
  const previous = backgroundCounts(before);
  const next = backgroundCounts(after);
  for (const [key, count] of previous) if (count > (next.get(key) ?? 0)) return true;
  return false;
}

function blockStartAt(doc: PMNode, position: number): { start: number; end: number } | null {
  const $position = doc.resolve(position);
  for (let depth = $position.depth; depth > 0; depth--) {
    const node = $position.node(depth);
    if (node.isTextblock) return { start: $position.before(depth), end: $position.after(depth) };
  }
  return null;
}

function nextTextblockStart(doc: PMNode, after: number): number | null {
  let found: number | null = null;
  doc.descendants((node, position) => {
    if (node.isTextblock && position >= after && found === null) {
      found = position;
      return false;
    }
    return found === null;
  });
  return found;
}

function itemHasHexBackground(item: PMNode): boolean {
  if (isHexBlockBackground(normalizeInlineColor(item.attrs.backgroundColor))) return true;
  let found = false;
  item.descendants((node) => {
    if (isHexBlockBackground(normalizeInlineColor(node.attrs.backgroundColor))) {
      found = true;
      return false;
    }
  });
  return found;
}

function nearbyJoinHasHexBackground(doc: PMNode, position: number): boolean {
  const current = blockStartAt(doc, position);
  if (!current) return false;
  const nextStart = nextTextblockStart(doc, current.end);
  const positions = [current.start, ...(nextStart === null ? [] : [nextStart])];
  for (const start of positions) {
    const $position = doc.resolve(start + 1);
    for (let depth = $position.depth; depth > 0; depth--) {
      const node = $position.node(depth);
      if (isHexBlockBackground(normalizeInlineColor(node.attrs.backgroundColor))) return true;
      if ((node.type.name === 'listItem' || node.type.name === 'taskItem') && itemHasHexBackground(node))
        return true;
    }
  }
  return false;
}

function previewJoinItemForward(state: EditorState): Transaction | null {
  const point = joinPoint(state.doc, state.selection.$from.pos, 1);
  if (point === null || point === undefined) return null;
  const $point = state.doc.resolve(point);
  if (
    !$point.nodeBefore ||
    !$point.nodeAfter ||
    $point.nodeBefore.type.spec.isolating ||
    $point.nodeAfter.type.spec.isolating
  ) {
    return null;
  }
  try {
    return state.tr.join(point, 2);
  } catch {
    return null;
  }
}

function previewForwardThenBackward(state: EditorState): Transaction | null {
  let forward: Transaction | null = null;
  if (!joinForward(state, (transaction) => (forward = transaction)) || !forward) return null;
  const afterForward = state.apply(forward);
  let backward: Transaction | null = null;
  if (joinBackward(afterForward, (transaction) => (backward = transaction)) && backward) return backward;
  return forward;
}

function previewLiftThenBackward(state: EditorState): Transaction | null {
  const target = resolveFocusPosition(state.doc, state.selection.from + 4);
  let focusedState = state;
  if (target && !state.selection.eq(target)) {
    focusedState = state.apply(state.tr.setSelection(target));
  }

  let lifted: Transaction | null = null;
  if (!lift(focusedState, (transaction) => (lifted = transaction)) || !lifted) return null;
  const afterLift = focusedState.apply(lifted);
  let backward: Transaction | null = null;
  if (joinBackward(afterLift, (transaction) => (backward = transaction)) && backward) return backward;
  return lifted;
}

function previewDeleteJoin(state: EditorState): Transaction | null {
  for (const itemName of ['listItem', 'taskItem']) {
    if (!isAtEndOfNode(state, itemName)) continue;
    if (listHelpers.nextListIsDeeper(itemName, state)) return previewLiftThenBackward(state);
    if (listHelpers.nextListIsHigher(itemName, state)) return previewForwardThenBackward(state);
    return previewJoinItemForward(state);
  }

  let forward: Transaction | null = null;
  if (joinForward(state, (transaction) => (forward = transaction)) && forward) return forward;
  return null;
}

function backgroundSensitiveDeleteJoin(state: EditorState): boolean {
  const { selection, doc } = state;
  if (!selection.empty || !selection.$from.parent.isTextblock) return false;
  if (selection.$from.parentOffset !== selection.$from.parent.content.size) return false;
  if (!nearbyJoinHasHexBackground(doc, selection.from)) return false;
  const preview = previewDeleteJoin(state);
  return preview !== null && preview.docChanged && losesBlockBackground(doc, preview.doc);
}

function listTypeForShortcut(event: KeyboardEvent): 'bulletList' | 'orderedList' | 'taskList' | null {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return null;
  const key =
    event.code === 'Digit7' || event.key === '7' || event.key === '&'
      ? '7'
      : event.code === 'Digit8' || event.key === '8' || event.key === '*'
        ? '8'
        : event.code === 'Digit9' || event.key === '9' || event.key === '('
          ? '9'
          : null;
  return key === '7' ? 'orderedList' : key === '8' ? 'bulletList' : key === '9' ? 'taskList' : null;
}

function backgroundSensitiveListShortcut(
  editor: Editor,
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  const targetList = listTypeForShortcut(event);
  const { selection, doc } = view.state;
  if (targetList) {
    const found = new Map<number, PMNode>();
    const addAt = (position: number, item: PMNode, parentList: PMNode) => {
      if (item.type.name !== 'listItem' && item.type.name !== 'taskItem') return;
      const taskConversion = (parentList.type.name === 'taskList') !== (targetList === 'taskList');
      if (
        listItemHasConflictingBackgrounds(item) &&
        (parentList.type.name === targetList || taskConversion)
      ) {
        found.set(position, item);
      }
    };
    if (selection.empty) {
      const { $from } = selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        addAt($from.before(depth), $from.node(depth), $from.node(depth - 1));
      }
    } else {
      doc.nodesBetween(selection.from, selection.to, (node, position) => {
        if (node.type.name !== 'listItem' && node.type.name !== 'taskItem') return true;
        const parentList = doc.resolve(position).parent;
        addAt(position, node, parentList);
        return true;
      });
    }
    if (!found.size) return false;

    // The task shortcut can safely convert this row when only its later paragraphs have colors.
    // Reuse the editor's checked conversion so both the item palette and those paragraphs survive.
    if (targetList === 'taskList' && selection.empty && found.size === 1) {
      const [position, item] = found.entries().next().value as [number, PMNode];
      if (
        item.type.name === 'taskItem' &&
        normalizeInlineColor(item.firstChild?.attrs.backgroundColor) === null &&
        canTurnListItem(editor, position, { kind: 'paragraph' }) &&
        turnListItem(editor, position, { kind: 'paragraph' })
      ) {
        return true;
      }
    }
    return true;
  }

  if (event.key === 'Delete') {
    if (isIndentedLinesDeleteCandidate(view.state)) {
      if (backgroundSensitiveDeleteBeforeList(editor, view)) return true;
    } else if (backgroundSensitiveDeleteJoin(view.state)) {
      return true;
    }
  }

  if (event.key === 'Delete' && selection.empty) {
    const { $from } = selection;
    if (!$from.parent.isTextblock || $from.parentOffset !== $from.parent.content.size) return false;
    for (let depth = $from.depth; depth > 0; depth--) {
      const item = $from.node(depth);
      if (item.type.name !== 'listItem' && item.type.name !== 'taskItem') continue;
      if ($from.index(depth) !== item.childCount - 1) return false;
      const parentList = $from.node(depth - 1);
      if (!['bulletList', 'orderedList', 'taskList'].includes(parentList.type.name)) return false;
      const nextItem = parentList.maybeChild($from.index(depth - 1) + 1);
      return nextItem !== null && listItemHasConflictingBackgrounds(nextItem);
    }
    return false;
  }

  if (event.key !== 'Backspace' || !selection.empty) return false;
  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph' || $from.parentOffset !== 0) return false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const item = $from.node(depth);
    if (
      (item.type.name === 'listItem' || item.type.name === 'taskItem') &&
      $from.index(depth) === 0 &&
      listItemHasConflictingBackgrounds(item)
    ) {
      return true;
    }
  }
  return false;
}

function transactionTouchesBlockBackground(transaction: Transaction): boolean {
  return transaction.steps.some((step, index) => {
    const sourceDoc = transaction.docs[index];
    const candidate = step as typeof step & {
      from?: unknown;
      to?: unknown;
      pos?: unknown;
      slice?: Slice;
    };
    if (candidate.slice && candidate.slice.content && fragmentHasBlockBackground(candidate.slice.content)) {
      return true;
    }
    if (!sourceDoc) return false;

    const positions = [candidate.from, candidate.pos, candidate.to].filter(
      (position): position is number => typeof position === 'number' && Number.isFinite(position),
    );
    if (positions.some((position) => listItemHasParagraphBackgroundAt(sourceDoc, position))) return true;

    if (typeof candidate.from === 'number' && typeof candidate.to === 'number') {
      if (candidate.from < 0 || candidate.to < candidate.from || candidate.to > sourceDoc.content.size) {
        return false;
      }
      return fragmentHasBlockBackground(sourceDoc.slice(candidate.from, candidate.to).content);
    }
    return false;
  });
}

const BlockBackground = Extension.create({
  name: 'blockBackground',
  // Its keyboard guard must precede StarterKit's list lift shortcut.
  priority: 1100,
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('blockBackgroundEmptyParagraph'),
        props: {
          handleKeyDown: (view, event) => {
            return backgroundSensitiveListShortcut(editor, view, event);
          },
        },
        filterTransaction: (transaction, state) =>
          !transaction.docChanged ||
          !transactionTouchesBlockBackground(transaction) ||
          !introducesUnsupportedCustomBlockBackground(state.doc, transaction.doc),
        appendTransaction: (transactions, _oldState, newState) => {
          if (
            !transactions.some((transaction) =>
              transaction.steps.some((step) => step instanceof ReplaceAroundStep),
            )
          )
            return null;
          const tr = newState.tr;
          for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex++) {
            const transaction = transactions[transactionIndex]!;
            for (let stepIndex = 0; stepIndex < transaction.steps.length; stepIndex++) {
              const step = transaction.steps[stepIndex]!;
              if (!(step instanceof ReplaceAroundStep)) continue;
              const oldNode = transaction.docs[stepIndex]?.nodeAt(step.from);
              const backgroundColor = normalizeInlineColor(oldNode?.attrs.backgroundColor);
              if (
                !oldNode ||
                oldNode.type.name !== 'paragraph' ||
                !isHexBlockBackground(backgroundColor) ||
                oldNode.nodeSize !== step.to - step.from
              ) {
                continue;
              }
              let newPosition = transaction.mapping.slice(stepIndex + 1).map(step.from, -1);
              let mappedEnd = transaction.mapping.slice(stepIndex + 1).map(step.to, 1);
              for (const later of transactions.slice(transactionIndex + 1)) {
                newPosition = later.mapping.map(newPosition, -1);
                mappedEnd = later.mapping.map(mappedEnd, 1);
              }
              const newNode = newState.doc.nodeAt(newPosition);
              if (
                !newNode ||
                newNode.type.name !== 'paragraph' ||
                newNode.content.size !== 0 ||
                newNode.attrs.backgroundColor != null ||
                newNode.nodeSize !== mappedEnd - newPosition
              ) {
                continue;
              }
              tr.setNodeMarkup(newPosition, undefined, { ...newNode.attrs, backgroundColor });
            }
          }
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'blockquote',
          'bulletList',
          'orderedList',
          'taskList',
          'listItem',
          'taskItem',
          'details',
        ],
        attributes: {
          backgroundColor: {
            default: null,
            keepOnSplit: true,
            parseHTML: (element) => normalizeInlineColor(element.getAttribute('data-background')),
            renderHTML: (attrs) => {
              const color = normalizeInlineColor(attrs.backgroundColor);
              if (!color) return {};
              if (color.startsWith('#')) {
                return {
                  'data-background': color,
                  class: 'block-bg block-bg-custom',
                  style: `--block-bg: ${color}`,
                };
              }
              return {
                'data-background': color,
                class: `block-bg block-bg-${color}`,
              };
            },
          },
        },
      },
    ];
  },
});

// a toggle's title can be a heading, the way notion's toggle headings fold a whole section away. the level
// lives on the title, so opening and closing the toggle never touches it
const ToggleSummary = DetailsSummary.extend({
  content: '(text | pageLink)*',
  addAttributes() {
    return {
      level: {
        default: null,
        parseHTML: (element) => {
          const level = Number(element.getAttribute('data-level'));
          return level >= 1 && level <= 6 ? level : null;
        },
        renderHTML: (attributes) => (attributes.level ? { 'data-level': String(attributes.level) } : {}),
      },
      backgroundColor: {
        default: null,
        parseHTML: (element) => {
          const color = normalizeInlineColor(element.getAttribute('data-block-background'));
          return isHexBlockBackground(color) ? color : null;
        },
        renderHTML: (attributes) => {
          const color = normalizeInlineColor(attributes.backgroundColor);
          return isHexBlockBackground(color) ? { 'data-block-background': color } : {};
        },
      },
    };
  },
});

// typing " and a space starts a quote and > and a space starts a toggle, the way notion does
const Quote = Blockquote.extend({
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*["“]\s$/, type: this.type })];
  },
});

// a. and a space at the start of a line starts a list counted in letters
const LetteredShortcut = Extension.create({
  name: 'letteredShortcut',
  addInputRules() {
    const type = this.editor.schema.nodes.orderedList;
    return type ? [wrappingInputRule({ find: /^\s*a\.\s$/, type, getAttributes: { type: 'a' } })] : [];
  },
});

// > and a space at the start of a line turns that line into a toggle's title, a heading keeping its level,
// with an empty line inside to write in. # to ###### and a space at the start of a toggle's title make it a
// toggle heading
const ToggleShortcut = Extension.create({
  name: 'toggleShortcut',
  priority: 1000,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*>\s$/,
        handler: ({ state, range, chain }) => {
          const $from = state.doc.resolve(range.from);
          const line = $from.parent;
          const { details, detailsSummary, detailsContent, paragraph } = state.schema.nodes;
          const start = $from.before();
          const parent = $from.node($from.depth - 1);
          const index = $from.index($from.depth - 1);
          const fits =
            details &&
            detailsSummary &&
            detailsContent &&
            paragraph &&
            (line.type.name === 'paragraph' || line.type.name === 'heading') &&
            parent.canReplaceWith(index, index + 1, details);
          if (!fits) {
            chain().deleteRange(range).setDetails().run();
            return;
          }
          const { tr } = state;
          tr.delete(range.from, range.to);
          const rest = tr.doc.nodeAt(start)!;
          const level = line.type.name === 'heading' ? (line.attrs.level as number) : null;
          const toggle = details.create({ open: true }, [
            detailsSummary.create(level ? { level } : null, lineContent(detailsSummary, rest)),
            detailsContent.create(null, paragraph.create()),
          ]);
          tr.replaceWith(start, start + rest.nodeSize, toggle);
          tr.setSelection(TextSelection.create(tr.doc, start + 2));
        },
      }),
      new InputRule({
        find: /^(#{1,6})\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.name !== 'detailsSummary') return null;
          const { tr } = state;
          tr.delete(range.from, range.to);
          tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, level: match[1]!.length });
        },
      }),
    ];
  },
});

// inline code can be bold, italic, struck through or coloured like any other text, as it can in notion and
// in markdown. tiptap's own code shuts every other mark out
const InlineCode = Code.extend({ excludes: '' });

export function createExtensions(options: ExtensionOptions): AnyExtension[] {
  return [
    BlockIds,
    BlockBackground,
    EmbedTitle,
    CodePreview,
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        defaultProtocol: 'https',
        protocols: ['http', 'https', 'mailto', 'file'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
      dropcursor: { color: 'var(--accent)', width: 2 },
      // no empty line is kept at the end of every page, ClickBelow adds one when the space under it is clicked
      trailingNode: false,
      codeBlock: false,
      code: false,
      blockquote: false,
    }),
    Quote,
    LetteredShortcut,
    ToggleShortcut,
    InlineCode,
    CodeBlock,
    Highlight,
    TextColor,
    RawBlock,
    LegacyFormula,
    PolarisDadosView.configure({ mountContext: options.linkedViewContext ?? null }),
    ...mathExtensions(),
    MathViewTracker,
    Tags(options.openTag),
    TaskList,
    TaskItem.configure({ nested: true }),
    IndentedLines,
    LineEdges,
    KeepTab,
    // columns are dragged wider or narrower at their edges, the widths are kept in the file
    Table.configure({ resizable: true, cellMinWidth: 60, lastColumnResizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Placeholder.configure({
      showOnlyCurrent: true,
      includeChildren: false,
      placeholder: ({ node, editor }) => {
        if (node.type.name === 'heading') return t('editor.headingPlaceholder', { level: node.attrs.level });
        if (node.type.name === 'detailsSummary')
          return node.attrs.level
            ? t('editor.headingPlaceholder', { level: node.attrs.level })
            : t('editor.toggleTitlePlaceholder');
        if (editor.isEmpty) return t('editor.placeholderEmpty');
        return t('editor.placeholder');
      },
    }),
    PageLink.configure({
      getTitle: options.getTitle,
      ...(options.getIcon ? { getIcon: options.getIcon } : {}),
      subscribe: options.subscribe,
      open: options.open,
      findPages: options.findPages,
      createPage: options.createPage,
      resolveTarget: options.resolveTarget,
      createFromTarget: options.createFromTarget,
      renderEmbed: options.renderEmbed,
      ...(options.mountEmbed ? { mountEmbed: options.mountEmbed } : {}),
    }),
    SlashCommand.configure({ createChild: options.createChild }),
    EmojiSuggest,
    CustomEmojiText,
    Image,
    FileAttachment,
    FileDrop,
    Callout,
    Columns,
    Column,
    ColumnGrip,
    TableOfContents,
    DateMention.configure({
      openDate: options.openDate,
      findPages: options.findPages,
      ...(options.dateMenu ? { dateMenu: options.dateMenu } : {}),
    }),
    Details.configure({ persist: true, HTMLAttributes: { class: 'toggle' } }),
    ToggleSummary,
    DetailsContent,
    FindReplace,
    CopyFromInside,
    PasteOnEmptyLine,
    PasteMenu,
    ClickBelow,
    BlockHandle.configure({ onMenu: options.onBlockMenu }),
    BlockSelect,
    MultiSelect,
    MarkdownPaste.configure({ resolvePage: options.resolvePage }),
  ];
}
