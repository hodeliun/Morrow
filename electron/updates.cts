// Kept as a pure helper for a future update channel; this private build makes no update requests.
export function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string) => {
    const [core = '', pre] = version.replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((part) => Number(part) || 0), pre: pre ?? null };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const difference = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  if (a.pre === b.pre) return false;
  return a.pre === null || (b.pre !== null && a.pre > b.pre);
}
