export interface DateRangeDraftInput {
  start: string;
  end: string;
}

export function dateRangeValueSignature(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function dateRangeDraftInput(value: unknown): DateRangeDraftInput {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'string')
    ? { start: value[0]!, end: value[1]! }
    : { start: '', end: '' };
}

export function reconcileDateRangeDraft(
  previousIdentity: string,
  nextIdentity: string,
  previousValueSignature: string,
  nextValueSignature: string,
  currentDraft: DateRangeDraftInput,
  nextValue: unknown,
): DateRangeDraftInput {
  if (previousIdentity === nextIdentity && previousValueSignature === nextValueSignature) return currentDraft;
  const nextDraft = dateRangeDraftInput(nextValue);
  return currentDraft.start === nextDraft.start && currentDraft.end === nextDraft.end
    ? currentDraft
    : nextDraft;
}
