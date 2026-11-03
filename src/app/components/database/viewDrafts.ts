export interface ViewSearchDraftResolution {
  draft: string;
  commit: string | null;
}

export type ViewSearchDraftAction =
  | { type: 'input'; value: string }
  | { type: 'commit'; value?: string }
  | { type: 'cancel' };

export function transitionViewSearchDraft(
  savedValue: string | undefined,
  currentDraft: string,
  action: ViewSearchDraftAction,
): ViewSearchDraftResolution {
  const saved = savedValue ?? '';
  if (action.type === 'input') return { draft: action.value, commit: null };
  if (action.type === 'cancel') return { draft: saved, commit: null };

  const value = action.value ?? currentDraft;
  return { draft: value, commit: value === saved ? null : value };
}
