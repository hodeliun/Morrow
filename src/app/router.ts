import { useMemo, useSyncExternalStore } from 'react';
import type { PageId } from '../core/model';
import {
  activeHash,
  routeHashForPane,
  routeHashForTabId,
  showInPane,
  subscribeTabs,
  targetPane,
  usePane,
  usePaneTabId,
} from './tabs';
import type { PaneId } from './tabs';

export type Route =
  | { name: 'home' }
  // anchor is a heading or ^block id to scroll to once the page opens
  | { name: 'page'; id: PageId; find: string | null; anchor?: string | null }
  | { name: 'tasks' }
  | { name: 'trash' }
  | { name: 'tags' }
  | { name: 'tag'; tag: string }
  | { name: 'graph'; focus: PageId | null }
  | { name: 'review' }
  | { name: 'search'; query: string };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'page' && parts[1]) {
    const params = new URLSearchParams(query);
    const find = params.get('find');
    const anchor = params.get('anchor');
    return { name: 'page', id: decodeURIComponent(parts[1]), find: find || null, anchor: anchor || null };
  }
  if (parts[0] === 'tasks') return { name: 'tasks' };
  if (parts[0] === 'trash') return { name: 'trash' };
  if (parts[0] === 'tags' && parts[1])
    return { name: 'tag', tag: decodeURIComponent(parts.slice(1).join('/')) };
  if (parts[0] === 'tags') return { name: 'tags' };
  if (parts[0] === 'review') return { name: 'review' };
  if (parts[0] === 'search') return { name: 'search', query: new URLSearchParams(query).get('q') ?? '' };
  if (parts[0] === 'graph') return { name: 'graph', focus: parts[1] ? decodeURIComponent(parts[1]) : null };
  return { name: 'home' };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'page': {
      const params = new URLSearchParams();
      if (route.find) params.set('find', route.find);
      if (route.anchor) params.set('anchor', route.anchor);
      const query = params.toString();
      return `#/page/${encodeURIComponent(route.id)}${query ? `?${query}` : ''}`;
    }
    case 'tasks':
      return '#/tasks';
    case 'trash':
      return '#/trash';
    case 'tags':
      return '#/tags';
    case 'tag':
      return `#/tags/${route.tag.split('/').map(encodeURIComponent).join('/')}`;
    case 'review':
      return '#/review';
    case 'search':
      return route.query ? `#/search?q=${encodeURIComponent(route.query)}` : '#/search';
    case 'graph':
      return route.focus ? `#/graph/${encodeURIComponent(route.focus)}` : '#/graph';
    default:
      return '#/';
  }
}

// Goes to the focused pane unless the caller names a pane explicitly.
export function navigate(route: Route, options: { replace?: boolean; pane?: PaneId } = {}): void {
  const hash = routeHash(route);
  const pane = options.pane ?? targetPane();
  showInPane(hash, pane, options.replace);
}

export function openPage(id: PageId, find: string | null = null, anchor: string | null = null): void {
  navigate({ name: 'page', id, find, anchor });
}

export function useRoute(): Route {
  const pane = usePane();
  const tabId = usePaneTabId();
  const hash = useSyncExternalStore(
    subscribeTabs,
    () => (tabId === null ? routeHashForPane(pane) : routeHashForTabId(tabId)),
    () => '#/',
  );
  return useMemo(() => parseRoute(hash), [hash]);
}

// the place shown where navigation goes, the side of a split tab when that side is in use
export function useActiveRoute(): Route {
  const hash = useSyncExternalStore(subscribeTabs, activeHash, () => '#/');
  return useMemo(() => parseRoute(hash), [hash]);
}

export function activeRoute(): Route {
  return parseRoute(activeHash());
}
