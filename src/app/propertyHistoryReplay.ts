import type { DatabaseDef, ViewDef } from '../core/model';

type JsonRecord = Record<string, unknown>;

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameField(left: JsonRecord, right: JsonRecord, key: string): boolean {
  const leftHas = hasOwn(left, key);
  const rightHas = hasOwn(right, key);
  return leftHas === rightHas && (!leftHas || sameJson(left[key], right[key]));
}

function setField(target: JsonRecord, source: JsonRecord, key: string): void {
  if (hasOwn(source, key)) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value: source[key],
      writable: true,
    });
  } else delete target[key];
}

/** Applies only fields changed by a legacy action, keeping later unrelated values intact. */
function rebaseChangedFields<T extends JsonRecord>(
  current: T,
  expected: JsonRecord,
  replacement: JsonRecord,
  skipKeys: ReadonlySet<string> = new Set(),
): T | null {
  const result: JsonRecord = { ...current };
  const keys = new Set([...Object.keys(expected), ...Object.keys(replacement)]);
  for (const key of keys) {
    if (skipKeys.has(key)) continue;
    if (sameField(expected, replacement, key)) continue;
    if (!sameField(current, expected, key)) return null;
    setField(result, replacement, key);
  }
  return result as T;
}

function uniqueViews(views: readonly ViewDef[]): Map<string, ViewDef> | null {
  const result = new Map<string, ViewDef>();
  for (const view of views) {
    if (!view || typeof view.id !== 'string' || result.has(view.id)) return null;
    result.set(view.id, view);
  }
  return result;
}

function rebaseViews(
  currentViews: readonly ViewDef[],
  expectedViews: readonly ViewDef[],
  replacementViews: readonly ViewDef[],
): ViewDef[] | null {
  const current = uniqueViews(currentViews);
  const expected = uniqueViews(expectedViews);
  const replacement = uniqueViews(replacementViews);
  if (!current || !expected || !replacement) return null;

  const expectedIds = expectedViews.map((view) => view.id);
  const replacementIds = replacementViews.map((view) => view.id);
  const eventChangedStructure = !sameJson(expectedIds, replacementIds);

  // If the legacy event changed membership/order, only replay against its exact expected structure.
  if (eventChangedStructure && !sameJson(currentViews.map((view) => view.id), expectedIds)) return null;

  if (!eventChangedStructure) {
    // Later membership and ordering are independent of this legacy event and remain current.
    const rebased: ViewDef[] = [];
    for (const currentView of currentViews) {
      const expectedView = expected.get(currentView.id);
      const replacementView = replacement.get(currentView.id);
      if (!expectedView || !replacementView) {
        rebased.push(currentView);
        continue;
      }
      const merged = rebaseChangedFields(
        currentView as unknown as JsonRecord,
        expectedView as unknown as JsonRecord,
        replacementView as unknown as JsonRecord,
      );
      if (!merged) return null;
      rebased.push(merged as unknown as ViewDef);
    }
    return rebased;
  }

  for (const [id, expectedView] of expected) {
    if (replacement.has(id)) continue;
    const currentView = current.get(id);
    if (!currentView || !sameJson(currentView, expectedView)) return null;
  }

  const rebased: ViewDef[] = [];
  for (const replacementView of replacementViews) {
    const expectedView = expected.get(replacementView.id);
    const currentView = current.get(replacementView.id);
    if (!expectedView) {
      rebased.push(replacementView);
      continue;
    }
    if (!currentView) return null;
    const merged = rebaseChangedFields(
      currentView as unknown as JsonRecord,
      expectedView as unknown as JsonRecord,
      replacementView as unknown as JsonRecord,
    );
    if (!merged) return null;
    rebased.push(merged as unknown as ViewDef);
  }
  return rebased;
}

/**
 * Replays one legacy database snapshot as a checked delta. Unchanged fields stay current;
 * fields changed by the legacy action are inverted only while they still match its expected side.
 */
export function rebaseDatabaseHistory(
  current: DatabaseDef,
  expected: DatabaseDef,
  replacement: DatabaseDef,
): DatabaseDef | null {
  if (!Array.isArray(current.views) || !Array.isArray(expected.views) || !Array.isArray(replacement.views))
    return null;
  const rebased = rebaseChangedFields(
    current as unknown as JsonRecord,
    expected as unknown as JsonRecord,
    replacement as unknown as JsonRecord,
    new Set(['views']),
  );
  if (!rebased) return null;
  const views = rebaseViews(current.views, expected.views, replacement.views);
  if (!views) return null;
  return { ...(rebased as unknown as DatabaseDef), views };
}
