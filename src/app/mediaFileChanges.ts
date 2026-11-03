export function affectsMediaFile(changes: unknown, relativePath: string): boolean {
  if (!Array.isArray(changes)) return false;
  return changes.some((change) => {
    if (
      typeof change !== 'object' ||
      change === null ||
      !('path' in change) ||
      !('other' in change) ||
      change.other !== true ||
      typeof change.path !== 'string'
    )
      return false;

    if (change.path === relativePath) return true;
    return (
      'dir' in change &&
      change.dir === true &&
      'text' in change &&
      change.text === null &&
      relativePath.startsWith(`${change.path}/`)
    );
  });
}
