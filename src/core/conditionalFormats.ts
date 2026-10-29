import type { ConditionalFormatRule, UnsupportedConditionalFormat } from './model';

// Reassembles opaque entries beside supported conditional-format rules without evaluating or rewriting them.
export function serializeConditionalFormats(
  rules: ConditionalFormatRule[] | undefined,
  unsupported: UnsupportedConditionalFormat[] | undefined,
): unknown {
  const wholeList = unsupported?.find((entry) => entry.wholeList);
  if (wholeList) return wholeList.raw;
  const supported = (rules ?? []).map((rule) => ({ ...rule }));
  const indexes = new Map(supported.map((rule, index) => [rule.id, index]));
  const insertions = new Map<number, UnsupportedConditionalFormat[]>();
  for (const entry of unsupported ?? []) {
    const afterIndex = entry.afterRuleId ? indexes.get(entry.afterRuleId) : undefined;
    const beforeIndex = entry.beforeRuleId ? indexes.get(entry.beforeRuleId) : undefined;
    const position =
      afterIndex !== undefined
        ? afterIndex
        : beforeIndex !== undefined
          ? beforeIndex + 1
          : Math.min(entry.index, supported.length);
    insertions.set(position, [...(insertions.get(position) ?? []), entry]);
  }
  const output: unknown[] = [];
  for (let position = 0; position <= supported.length; position++) {
    const opaque = (insertions.get(position) ?? []).sort((a, b) => a.index - b.index);
    output.push(...opaque.map((entry) => entry.raw));
    if (position < supported.length) output.push(supported[position]);
  }
  return output;
}
