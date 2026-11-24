import type { PageMeta, WorkspaceState } from '../../core/model';

/** Pages carrying the provider marker, and rows in a marked database, are owned by that provider. */
export function isProviderManagedPage(state: WorkspaceState, page: PageMeta): boolean {
  if (Object.hasOwn(page.extra, 'polarisDados')) return true;
  const parent = page.parentId ? state.pages[page.parentId] : undefined;
  return parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados');
}

export function canMoveTreePage(
  state: WorkspaceState,
  source: PageMeta,
  target: PageMeta,
  zone: 'before' | 'inside' | 'after',
): boolean {
  if (isProviderManagedPage(state, source)) return false;
  if (zone === 'inside') return !isProviderManagedPage(state, target);
  const targetParent = target.parentId ? state.pages[target.parentId] : undefined;
  return !(targetParent?.kind === 'database' && Object.hasOwn(targetParent.extra, 'polarisDados'));
}
