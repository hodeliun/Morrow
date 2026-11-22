import type { Editor } from '@tiptap/core';
import { BACKGROUND_HEX, inlineColorHex, normalizeInlineColor, TEXT_HEX } from '../../core/model';
import type { InlineColor } from '../../core/model';
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

  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; selectionSet: boolean } }) => {
    if (!transaction.docChanged && !transaction.selectionSet) return;
    if (applying) {
      changedDuringApply = true;
      return;
    }
    invalidated = true;
  };
  editor.on('transaction', onTransaction);

  const isOwnerCurrent = () => {
    if (disposed || invalidated || !registration.isActive() || editor.isDestroyed || !editor.isEditable) return false;
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
