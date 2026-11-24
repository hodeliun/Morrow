import type { Editor } from '@tiptap/core';
import { BACKGROUND_HEX, inlineColorHex, normalizeInlineColor, TEXT_HEX } from '../../core/model';
import type { InlineColor } from '../../core/model';
import { isHexBlockBackground, supportsHexBlockBackgroundOwner } from '../../core/markdown/blockBackground';
import type {
  PluginInlineColorControlHost,
  PluginInlineColorControlEntry,
  PluginInlineColorKind,
} from '../plugins/registry';

export interface InlineColorControlHostOptions {
  editor: Editor;
  kind: PluginInlineColorKind;
  registration: PluginInlineColorControlEntry;
  label: string;
  inputLabel: string;
  invalidMessage: string;
  isSessionActive: () => boolean;
  onFinish: () => void;
}

export interface MountedInlineColorControlHost {
  host: PluginInlineColorControlHost;
  dispose(): void;
}

export interface RepresentableBlockBackgroundOwner {
  readonly position: number;
  readonly color: InlineColor | null;
}

/** Resolve only the exact node or collapsible title represented by the existing HEX background codec. */
export function representableBlockBackgroundOwners(
  editor: Editor,
  positions: readonly number[],
): RepresentableBlockBackgroundOwner[] {
  const { doc } = editor.state;
  const owners = new Map<number, RepresentableBlockBackgroundOwner>();
  const add = (position: number) => {
    const node = doc.nodeAt(position);
    if (!node || !('backgroundColor' in node.attrs)) return;
    const $position = doc.resolve(position);
    const ancestors = Array.from(
      { length: $position.depth + 1 },
      (_unused, depth) => $position.node(depth).type.name,
    );
    const firstTaskItemParagraph =
      node.type.name === 'paragraph' && $position.parent.type.name === 'taskItem' && $position.index() === 0;
    if (!supportsHexBlockBackgroundOwner(node.type.name, ancestors, firstTaskItemParagraph)) return;
    owners.set(position, {
      position,
      color: normalizeInlineColor(node.attrs.backgroundColor),
    });
  };

  for (const position of new Set(positions)) {
    const node = doc.nodeAt(position);
    if (node?.type.name === 'details' && node.firstChild?.type.name === 'detailsSummary') add(position + 1);
    else add(position);
  }
  return [...owners.values()];
}

export interface BlockBackgroundControlHostOptions {
  readonly editor: Editor;
  readonly registration: PluginInlineColorControlEntry;
  readonly color: string;
  readonly label: string;
  readonly inputLabel: string;
  readonly invalidMessage: string;
  readonly apply: (color: InlineColor) => boolean;
  readonly isSessionActive: () => boolean;
  readonly isLeaseActive: () => boolean;
  readonly isTargetSelectionCurrent: () => boolean;
  readonly onFinish: () => void;
  readonly onInvalidate?: () => void;
}

/** Bind Documento's reused HEX control to one menu request and its representable block-background owners. */
export function createBlockBackgroundControlHost(
  options: BlockBackgroundControlHostOptions,
): MountedInlineColorControlHost | null {
  const { editor, registration } = options;
  const check = (predicate: () => boolean) => {
    try {
      return predicate();
    } catch {
      return false;
    }
  };
  if (
    editor.isDestroyed ||
    !editor.isEditable ||
    registration.owner !== 'polaris-documento' ||
    !check(registration.isActive) ||
    !check(options.isSessionActive) ||
    !check(options.isLeaseActive) ||
    !check(options.isTargetSelectionCurrent)
  ) {
    return null;
  }

  const doc = editor.state.doc;
  const selection = editor.state.selection;
  let disposed = false;
  let invalidated = false;
  let applying = false;
  let changedDuringApply = false;
  let writeConsumed = false;
  let finished = false;
  let docAfterApply: typeof doc | null = null;
  let selectionAfterApply: typeof selection | null = null;

  const invalidate = () => {
    if (disposed || invalidated) return;
    invalidated = true;
    options.onInvalidate?.();
  };

  const isOwnerCurrent = () =>
    !disposed &&
    !invalidated &&
    !editor.isDestroyed &&
    editor.isEditable &&
    check(registration.isActive) &&
    check(options.isSessionActive) &&
    check(options.isLeaseActive);

  const isCurrent = () => {
    if (!isOwnerCurrent() || writeConsumed) return false;
    const matches =
      editor.state.doc === doc &&
      editor.state.selection === selection &&
      check(options.isTargetSelectionCurrent);
    if (!matches) invalidate();
    return matches;
  };

  const isCurrentForFinish = () => {
    if (!isOwnerCurrent() || finished) return false;
    const expectedDoc = writeConsumed ? docAfterApply : doc;
    const expectedSelection = writeConsumed ? selectionAfterApply : selection;
    const matches =
      editor.state.doc === expectedDoc &&
      editor.state.selection === expectedSelection &&
      (writeConsumed || check(options.isTargetSelectionCurrent));
    if (!matches) invalidate();
    return matches;
  };

  const onTransaction = ({
    transaction,
  }: {
    transaction: { docChanged: boolean; selectionSet: boolean };
  }) => {
    if (applying) {
      changedDuringApply = true;
      return;
    }
    if (
      transaction.docChanged ||
      transaction.selectionSet ||
      editor.state.doc !== doc ||
      editor.state.selection !== selection ||
      !check(options.isTargetSelectionCurrent)
    ) {
      invalidate();
    }
  };
  editor.on('transaction', onTransaction);

  const host: PluginInlineColorControlHost = {
    color: options.color,
    label: options.label,
    inputLabel: options.inputLabel,
    invalidMessage: options.invalidMessage,
    disabled: false,
    apply(value) {
      if (!isCurrent()) return false;
      const color = normalizeInlineColor(value);
      if (!isHexBlockBackground(color)) return false;
      let applied = false;
      applying = true;
      changedDuringApply = false;
      try {
        applied = options.apply(color);
      } finally {
        applying = false;
        if (changedDuringApply && !applied) invalidate();
      }
      if (applied) {
        writeConsumed = true;
        docAfterApply = editor.state.doc;
        selectionAfterApply = editor.state.selection;
      }
      return applied;
    },
    finish() {
      if (!isCurrentForFinish()) return;
      finished = true;
      editor.commands.focus();
      options.onFinish();
    },
  };

  return {
    host,
    dispose() {
      if (disposed) return;
      disposed = true;
      editor.off('transaction', onTransaction);
    },
  };
}

/** Bind a plugin color input to one selected range, one editor session, and one live plugin registration. */
export function createInlineColorControlHost(
  options: InlineColorControlHostOptions,
): MountedInlineColorControlHost | null {
  const { editor, kind, registration } = options;
  const isSessionActive = () => {
    try {
      return options.isSessionActive();
    } catch {
      return false;
    }
  };
  if (editor.isDestroyed || !editor.isEditable || !registration.isActive() || !isSessionActive()) return null;
  const selection = editor.state.selection;
  if (selection.empty) return null;

  const doc = editor.state.doc;
  const { anchor, head, from, to } = selection;
  const selectedText = editor.state.doc.textBetween(from, to, '\n');
  const palette = kind === 'text' ? TEXT_HEX : BACKGROUND_HEX;
  const fallback = kind === 'text' ? TEXT_HEX.gray : BACKGROUND_HEX.yellow;
  const marked =
    kind === 'text' ? editor.getAttributes('textColor').color : editor.getAttributes('highlight').color;
  const normalized = normalizeInlineColor(marked);
  let disposed = false;
  let invalidated = false;
  let applying = false;
  let changedDuringApply = false;
  let writeConsumed = false;
  let finished = false;
  let docAfterApply: typeof doc | null = null;
  let selectionAfterApply: typeof selection | null = null;

  const onTransaction = ({
    transaction,
  }: {
    transaction: { docChanged: boolean; selectionSet: boolean };
  }) => {
    if (!transaction.docChanged && !transaction.selectionSet) return;
    if (applying) {
      changedDuringApply = true;
      return;
    }
    invalidated = true;
  };
  editor.on('transaction', onTransaction);

  const isOwnerCurrent = () => {
    if (disposed || invalidated || !registration.isActive() || editor.isDestroyed || !editor.isEditable)
      return false;
    return isSessionActive();
  };

  const isCurrent = () => {
    if (!isOwnerCurrent() || writeConsumed) return false;
    if (editor.state.doc !== doc) {
      invalidated = true;
      return false;
    }
    const current = editor.state.selection;
    const matches =
      current === selection &&
      current.anchor === anchor &&
      current.head === head &&
      editor.state.doc.textBetween(from, to, '\n') === selectedText;
    if (!matches) invalidated = true;
    return matches;
  };

  const isCurrentForFinish = () => {
    if (!isOwnerCurrent() || finished) return false;
    const expectedDoc = writeConsumed ? docAfterApply : doc;
    const expectedSelection = writeConsumed ? selectionAfterApply : selection;
    if (editor.state.doc !== expectedDoc || editor.state.selection !== expectedSelection) {
      invalidated = true;
      return false;
    }
    return true;
  };

  const host: PluginInlineColorControlHost = {
    color: (normalized ? inlineColorHex(normalized, palette) : null) ?? fallback,
    label: options.label,
    inputLabel: options.inputLabel,
    invalidMessage: options.invalidMessage,
    disabled: false,
    apply(value) {
      if (!isCurrent()) return false;
      const color = normalizeInlineColor(value);
      if (!color) return false;
      let applied = false;
      applying = true;
      changedDuringApply = false;
      try {
        applied =
          kind === 'text'
            ? editor.commands.setTextColor(color as InlineColor)
            : editor.commands.setHighlightColor(color as InlineColor);
      } finally {
        applying = false;
        if (changedDuringApply && !applied) invalidated = true;
      }
      if (applied) {
        writeConsumed = true;
        docAfterApply = editor.state.doc;
        selectionAfterApply = editor.state.selection;
      }
      return applied;
    },
    finish() {
      if (!isCurrentForFinish()) return;
      finished = true;
      editor.commands.focus();
      options.onFinish();
    },
  };

  return {
    host,
    dispose() {
      if (disposed) return;
      disposed = true;
      editor.off('transaction', onTransaction);
    },
  };
}
