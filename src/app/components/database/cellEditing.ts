export type CellEditStartKey = { kind: 'none' } | { kind: 'composition' } | { kind: 'text'; text: string };
export type CellPickerStartProps = { initialText?: string; openPickerOnEdit?: true };

export function parseCellNumberDraft(raw: string, locale = 'en-US'): number | null {
  const text = raw.trim();
  if (!text) return null;

  let decimalSeparator = '.';
  try {
    decimalSeparator = new Intl.NumberFormat(locale)
      .formatToParts(1.1)
      .find((part) => part.type === 'decimal')?.value ?? '.';
  } catch {
    // A malformed saved locale should not make otherwise standard dot decimals unusable.
  }

  const hasLocaleDecimal = decimalSeparator !== '.' && text.includes(decimalSeparator);
  if (hasLocaleDecimal && text.includes('.')) return null;
  const normalized = hasLocaleDecimal ? text.split(decimalSeparator).join('.') : text;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) return null;

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export function isCellEditableNow(editable: boolean, canEditNow?: () => boolean): boolean {
  return editable && (canEditNow?.() ?? true);
}

export function cellPickerStartProps(
  propType: string | undefined,
  startKey: CellEditStartKey,
): CellPickerStartProps {
  if (!['select', 'multiSelect', 'relation'].includes(propType ?? '') || startKey.kind === 'none')
    return {};
  if (startKey.kind === 'composition') return { openPickerOnEdit: true };
  return { initialText: startKey.text, openPickerOnEdit: true };
}

type CellEditorCaretTarget =
  | Pick<HTMLInputElement, 'type' | 'value' | 'setSelectionRange'>
  | Pick<HTMLTextAreaElement, 'value' | 'setSelectionRange'>;

export type CellDraftCommitAttempt<Result> =
  | { kind: 'readonly' }
  | { kind: 'unchanged' }
  | { kind: 'invalid'; error: string }
  | { kind: 'committed'; draft: string; result: Result };

export function placeInitialCellDraftCaret(
  element: CellEditorCaretTarget,
  pending: { current: boolean },
): void {
  if (!pending.current) return;
  pending.current = false;
  if ('type' in element && element.type === 'number') return;

  const end = element.value.length;
  element.setSelectionRange(end, end);
}

export function attemptCellDraftCommit<Result>({
  editable,
  canEditNow,
  draft,
  value,
  validate,
  onCommit,
}: {
  editable: boolean;
  canEditNow?: () => boolean;
  draft: string | null;
  value: string;
  validate?: (draft: string) => string | null;
  onCommit: (draft: string) => Result;
}): CellDraftCommitAttempt<Result> {
  if (!isCellEditableNow(editable, canEditNow)) return { kind: 'readonly' };
  if (draft === null || draft === value) return { kind: 'unchanged' };

  const error = validate?.(draft) ?? null;
  if (error) return { kind: 'invalid', error };

  return { kind: 'committed', draft, result: onCommit(draft) };
}

export function cellEditStartKey(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  altGraph?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): CellEditStartKey {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.keyCode === 229)
    return { kind: 'composition' };

  const altGraph = event.altGraph === true;
  if ((event.ctrlKey || event.metaKey) && !altGraph) return { kind: 'none' };
  if (event.altKey && !altGraph) return { kind: 'none' };
  if (!event.key || /\p{C}/u.test(event.key)) return { kind: 'none' };
  if (
    /^(?:Arrow(?:Up|Down|Left|Right)|Enter|Tab|Escape|Backspace|Delete|F\d+|Home|End|PageUp|PageDown|Insert|ContextMenu|Shift|Control|Alt|Meta|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|Unidentified)$/i.test(
      event.key,
    )
  )
    return { kind: 'none' };
  if (Array.from(event.key).length > 1 && /^[A-Za-z]+$/.test(event.key)) return { kind: 'none' };

  // KeyboardEvent.key contains the printable text, including a space or a non-ASCII character.
  return { kind: 'text', text: event.key };
}
