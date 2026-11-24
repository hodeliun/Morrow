export type CellEditStartKey =
  | { readonly kind: 'none' }
  | { readonly kind: 'composition' }
  | { readonly kind: 'text'; readonly text: string };

export function cellEditStartKey(event: {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly altGraph?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}): CellEditStartKey {
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.keyCode === 229)
    return { kind: 'composition' };

  const altGraph = event.altGraph === true;
  if (event.metaKey || (event.ctrlKey && !altGraph)) return { kind: 'none' };
  if (event.altKey && !altGraph) return { kind: 'none' };
  if (!event.key || /\p{C}/u.test(event.key)) return { kind: 'none' };
  if (
    /^(?:Arrow(?:Up|Down|Left|Right)|Enter|Tab|Escape|Backspace|Delete|F\d+|Home|End|PageUp|PageDown|Insert|ContextMenu|Shift|Control|Alt|Meta|CapsLock|NumLock|ScrollLock|Pause|PrintScreen|Unidentified)$/i.test(
      event.key,
    )
  )
    return { kind: 'none' };
  if (Array.from(event.key).length > 1 && /^[A-Za-z0-9]+$/.test(event.key)) return { kind: 'none' };

  return { kind: 'text', text: event.key };
}
