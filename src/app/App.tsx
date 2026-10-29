import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './styles/panes.css';
import { t } from './i18n';
import { ACTIONS, matchesShortcut, runAction } from './actions';
import { CommandPalette } from './components/CommandPalette';
import { Dialogs } from './components/Dialogs';
import { ReviewView } from './components/ReviewView';
import { TagsView, TagView } from './components/TagsView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PageView } from './components/PageView';
import { Toasts } from './components/primitives';
import { TabBar } from './components/TabBar';
import { SearchView } from './components/SearchView';
import { Sidebar } from './components/Sidebar';
import { HomeView } from './components/Home';
import { TasksView, TrashView } from './components/Views';
import { commitEditors, undoRedo } from './editor/commits';
import { ensureToday, writeAutoBackup } from './operations';
import { startAutoSync, syncWith } from './sync';
import { startUpdateChecks } from './updates';
import { desktop, isMac, watchTitleBar } from './platform/desktop';
import { getPreferences, resolvedTheme, usePreferences } from './platform/preferences';
import { navigate, parseRoute, routeHash, useActiveRoute } from './router';
import type { Route } from './router';
import { getUi, setUi, toast, useUi } from './ui';
import { loadCustomCss } from './customCss';
import {
  activateTabAt,
  beginPaneResize,
  cancelPaneResizeSession,
  claimNavigation,
  commitPaneResizeSession,
  goBack,
  paneIdForTabId,
  PaneContext,
  PaneTabContext,
  previewPaneResizeSession,
  resetPaneSplitRatio,
  setActivePane,
  startTabs,
  useTabs,
} from './tabs';
import type { PaneId } from './tabs';
import type { PaneNode, PaneSplit } from './paneLayout';
import { getSession } from './workspace';

const AUTO_BACKUP_MS = 10 * 60 * 1000;
// Keep previously displayed route trees mounted while their tab instances remain open.
interface PaneMountCache {
  readonly sessionId: number;
  readonly mountedTabIds: Set<string>;
}

const paneMountCaches = new WeakMap<object, PaneMountCache>();
let nextPaneMountSessionId = 0;

function paneMountCacheFor(session: object): PaneMountCache {
  let cache = paneMountCaches.get(session);
  if (!cache) {
    cache = { sessionId: ++nextPaneMountSessionId, mountedTabIds: new Set() };
    paneMountCaches.set(session, cache);
  }
  return cache;
}

// the assistant is only loaded for people who turned it on
const AssistantPanel = lazy(() =>
  import('./assistant/AssistantPanel').then((module) => ({ default: module.AssistantPanel })),
);

// the graph pulls in a physics library, it is only loaded when opened
const GraphView = lazy(() =>
  import('./components/GraphView').then((module) => ({ default: module.GraphView })),
);

function useTheme(theme: 'system' | 'light' | 'dark') {
  useEffect(() => {
    const apply = () => {
      const resolved = resolvedTheme(theme);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
      desktop?.setTheme(resolved);
    };
    watchTitleBar();
    apply();
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const ui = getUi();
      if (ui.dialog) return;
      if (event.key === 'Escape' && ui.focusMode && !ui.palette) {
        setUi({ focusMode: false });
        return;
      }
      // ctrl or cmd and a number picks a tab, nine is always the last one
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        activateTabAt(Number(digit[1]));
        return;
      }
      if (matchesShortcut(event, 'Mod+P')) {
        event.preventDefault();
        setUi({ palette: !ui.palette });
        return;
      }
      for (const action of ACTIONS) {
        if (action.shortcut && matchesShortcut(event, action.shortcut)) {
          event.preventDefault();
          if (ui.palette && action.id !== 'search') setUi({ palette: false });
          runAction(action.id);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

// pending edits are written before the window goes away
function useLifecycle() {
  useEffect(() => {
    const session = getSession();
    const flush = () => {
      commitEditors();
      void session.flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      commitEditors();
      if (desktop || !session.queue.hasPending()) return;
      void session.flush();
      event.preventDefault();
    };
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibility);

    const unsubscribe = desktop?.onCommand(async (id) => {
      if (id === 'app.prepareToClose') {
        commitEditors();
        await session.flush();
        await writeAutoBackup();
        return;
      }
      if ((id === 'go.back' || id === 'go.forward') && !claimNavigation()) return;
      if (id === 'edit.undo' || id === 'edit.redo') {
        undoRedo(id === 'edit.undo' ? 'undo' : 'redo');
        return;
      }
      runAction(id);
    });

    void loadCustomCss();
    const stopSync = startAutoSync();
    const stopUpdates = startUpdateChecks();
    // a vault just copied from another computer fills up straight away
    const copyFrom = sessionStorage.getItem('morrow.syncAfterOpen');
    if (copyFrom) {
      sessionStorage.removeItem('morrow.syncAfterOpen');
      void syncWith(copyFrom).then((result) =>
        toast(
          result.ok
            ? result.received === 1
              ? t('toasts.syncCopiedFilesSingle')
              : t('toasts.syncCopiedFilesPlural', { count: result.received })
            : t('toasts.syncCopyFailed', { error: result.error ?? '' }),
          {
            tone: result.ok ? 'info' : 'error',
            durationMs: 10_000,
          },
        ),
      );
    }
    const first = desktop ? setTimeout(() => void writeAutoBackup(), 30_000) : null;
    const timer = desktop ? setInterval(() => void writeAutoBackup(), AUTO_BACKUP_MS) : null;
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.();
      stopSync();
      stopUpdates();
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
    };
  }, []);
}

function viewFor(route: Route) {
  switch (route.name) {
    case 'page':
      return <PageView key={route.id} id={route.id} find={route.find} anchor={route.anchor ?? null} />;
    case 'tasks':
      return <TasksView />;
    case 'trash':
      return <TrashView />;
    case 'tags':
      return <TagsView />;
    case 'tag':
      return <TagView tag={route.tag} />;
    case 'review':
      return <ReviewView />;
    case 'graph':
      return <GraphView key={route.focus ?? 'all'} focus={route.focus} />;
    case 'search':
      return <SearchView query={route.query} />;
    default:
      return <HomeView />;
  }
}

// how much room a side has, so its bars and page fit it whether it fills the window or half of it
type PaneSize = 'narrow' | 'medium' | 'wide';
function usePaneSize(ref: React.RefObject<HTMLElement | null>): PaneSize {
  const [size, setSize] = useState<PaneSize>('wide');
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (width: number) => setSize(width < 620 ? 'narrow' : width < 900 ? 'medium' : 'wide');
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => entry && measure(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface PaneRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface VisiblePaneGeometry {
  readonly id: string;
  readonly tabId: string | null;
  readonly rect: PaneRect;
}

interface SplitGeometry {
  readonly split: PaneSplit;
  readonly rect: PaneRect;
}

function collectPaneGeometry(
  node: PaneNode,
  rect: PaneRect = { left: 0, top: 0, width: 100, height: 100 },
  panes: VisiblePaneGeometry[] = [],
  splits: SplitGeometry[] = [],
): { panes: VisiblePaneGeometry[]; splits: SplitGeometry[] } {
  if (node.kind === 'leaf') {
    panes.push({ id: node.id, tabId: node.tabId, rect });
    return { panes, splits };
  }
  splits.push({ split: node, rect });
  if (node.axis === 'columns') {
    const firstWidth = rect.width * node.ratio;
    collectPaneGeometry(node.first, { ...rect, width: firstWidth }, panes, splits);
    collectPaneGeometry(
      node.second,
      { ...rect, left: rect.left + firstWidth, width: rect.width - firstWidth },
      panes,
      splits,
    );
  } else {
    const firstHeight = rect.height * node.ratio;
    collectPaneGeometry(node.first, { ...rect, height: firstHeight }, panes, splits);
    collectPaneGeometry(
      node.second,
      { ...rect, top: rect.top + firstHeight, height: rect.height - firstHeight },
      panes,
      splits,
    );
  }
  return { panes, splits };
}

function Pane({
  pane,
  paneNumber,
  primary,
  titlebarEdgeRight,
  tabId,
  route,
  active,
  rect,
  hidden = false,
}: {
  pane: PaneId;
  paneNumber: number;
  primary: boolean;
  titlebarEdgeRight: boolean;
  tabId: string | null;
  route: Route | null;
  active: boolean;
  rect: PaneRect;
  hidden?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const size = usePaneSize(ref);
  return (
    <PaneContext.Provider value={pane}>
      <PaneTabContext.Provider value={tabId}>
        <section
          ref={ref}
          className={`pane${active ? ' is-active' : ''}${hidden ? ' is-cached' : ''}`}
          data-pane={pane}
          data-pane-primary={primary || undefined}
          data-pane-titlebar-right={titlebarEdgeRight || undefined}
          data-tab-id={tabId ?? undefined}
          data-size={size}
          aria-label={t('paneLayout.paneNumber', { number: paneNumber })}
          aria-hidden={hidden || undefined}
          style={{
            left: `${rect.left}%`,
            top: `${rect.top}%`,
            width: `${rect.width}%`,
            height: `${rect.height}%`,
            display: hidden ? 'none' : undefined,
          }}
          onPointerDownCapture={() => setActivePane(pane)}
          onFocusCapture={() => setActivePane(pane)}
        >
          {route ? (
            <ErrorBoundary resetKey={`${tabId}:${routeHash(route)}`}>
              <Suspense fallback={<div className="view" aria-busy="true" />}>{viewFor(route)}</Suspense>
            </ErrorBoundary>
          ) : (
            <div className="pane-empty">{t('paneLayout.empty')}</div>
          )}
        </section>
      </PaneTabContext.Provider>
    </PaneContext.Provider>
  );
}

function SplitResizer({ split, rect }: SplitGeometry) {
  const sessionRef = useRef<ReturnType<typeof beginPaneResize>>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const viewport = handle.parentElement!.getBoundingClientRect();
    const bounds = {
      left: viewport.left + (viewport.width * rect.left) / 100,
      top: viewport.top + (viewport.height * rect.top) / 100,
      width: (viewport.width * rect.width) / 100,
      height: (viewport.height * rect.height) / 100,
    };
    const session = beginPaneResize(split.id);
    if (!session) return;
    sessionRef.current = session;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      const extent = split.axis === 'columns' ? bounds.width : bounds.height;
      if (!extent) return;
      const position = split.axis === 'columns' ? moved.clientX - bounds.left : moved.clientY - bounds.top;
      previewPaneResizeSession(session, position / extent);
    };
    const finish = (cancel: boolean) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancelResize);
      window.removeEventListener('keydown', onResizeKey, true);
      sessionRef.current = null;
      if (cancel) cancelPaneResizeSession(session);
      else commitPaneResizeSession(session);
    };
    const up = () => finish(false);
    const cancelResize = () => finish(true);
    const onResizeKey = (key: KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      finish(true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancelResize);
    window.addEventListener('keydown', onResizeKey, true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Home') {
      event.preventDefault();
      resetPaneSplitRatio(split.id);
      return;
    }
    if (event.key === 'Escape' && sessionRef.current) {
      event.preventDefault();
      cancelPaneResizeSession(sessionRef.current);
      sessionRef.current = null;
      return;
    }
    const negative = split.axis === 'columns' ? 'ArrowLeft' : 'ArrowUp';
    const positive = split.axis === 'columns' ? 'ArrowRight' : 'ArrowDown';
    const step = event.key === negative ? -0.05 : event.key === positive ? 0.05 : 0;
    if (!step) return;
    event.preventDefault();
    const session = beginPaneResize(split.id);
    if (!session) return;
    previewPaneResizeSession(session, split.ratio + step);
    commitPaneResizeSession(session);
  };

  const style: React.CSSProperties =
    split.axis === 'columns'
      ? {
          left: `${rect.left + rect.width * split.ratio}%`,
          top: `${rect.top}%`,
          height: `${rect.height}%`,
        }
      : {
          left: `${rect.left}%`,
          top: `${rect.top + rect.height * split.ratio}%`,
          width: `${rect.width}%`,
        };

  return (
    <div
      className={`split-resizer is-${split.axis}`}
      role="separator"
      tabIndex={0}
      style={style}
      data-axis={split.axis}
      data-split-id={split.id}
      aria-orientation={split.axis === 'columns' ? 'vertical' : 'horizontal'}
      aria-label={t(split.axis === 'columns' ? 'paneLayout.resizeColumns' : 'paneLayout.resizeRows')}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-valuenow={Math.round(split.ratio * 100)}
      title={t('paneLayout.resizeHelp')}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => resetPaneSplitRatio(split.id)}
    />
  );
}

// the first view after opening, once per window
let started = false;
function useStartPage() {
  useEffect(() => {
    if (started) return;
    started = true;
    // a window opened at a particular place, or a brand new vault showing its guide, stays as it is
    if ((window.location.hash && window.location.hash !== '#/') || getSession().firstRun) return;
    const start = getPreferences().startPage;
    if (start === 'last') goBack();
    else if (start === 'today') {
      const id = ensureToday();
      if (id) navigate({ name: 'page', id, find: null }, { replace: true });
    }
  }, []);
}

export function App() {
  const mountCache = paneMountCacheFor(getSession());
  const route = useActiveRoute();
  const ui = useUi();
  const prefs = usePreferences();
  const tabs = useTabs();
  const geometry = useMemo(() => collectPaneGeometry(tabs.layout.root), [tabs.layout.root]);
  const visibleAssignments = useMemo(
    () =>
      geometry.panes.filter((pane): pane is VisiblePaneGeometry & { tabId: string } => pane.tabId !== null),
    [geometry.panes],
  );
  const registeredTabIds = useMemo(() => tabs.layout.tabs.map((tab) => tab.id), [tabs.layout.tabs]);
  const primaryPaneId = visibleAssignments[0]?.id ?? geometry.panes[0]?.id;
  const paneNumberByTabId = new Map<string, number>();
  const topRowPanes = geometry.panes.filter((pane) => pane.rect.top === 0);
  const titlebarRightPaneId = topRowPanes.reduce<string | null>((rightmost, pane) => {
    const right = rightmost ? geometry.panes.find((candidate) => candidate.id === rightmost) : null;
    return !right || pane.rect.left + pane.rect.width > right.rect.left + right.rect.width
      ? pane.id
      : rightmost;
  }, null);
  geometry.panes.forEach((pane, index) => {
    if (pane.tabId) paneNumberByTabId.set(pane.tabId, index + 1);
  });

  useLayoutEffect(() => {
    for (const pane of visibleAssignments) {
      mountCache.mountedTabIds.add(pane.tabId);
    }
    const liveIds = new Set(registeredTabIds);
    for (const id of mountCache.mountedTabIds) if (!liveIds.has(id)) mountCache.mountedTabIds.delete(id);
  }, [mountCache, registeredTabIds, visibleAssignments]);

  useTheme(prefs.theme);
  useEffect(() => {
    document.documentElement.dataset.accent = prefs.accent;
    document.documentElement.dataset.colorful = prefs.colorful ? 'true' : 'false';
  }, [prefs.accent, prefs.colorful]);
  useGlobalShortcuts();
  useEffect(() => startTabs(), []);
  useStartPage();
  useLifecycle();

  useEffect(() => {
    setUi({ mobileSidebar: false });
  }, [route]);

  const visibleByTabId = new Map<string, VisiblePaneGeometry & { paneNumber: number }>();
  geometry.panes.forEach((pane, index) => {
    if (pane.tabId) visibleByTabId.set(pane.tabId, { ...pane, paneNumber: index + 1 });
  });
  const paneHosts = tabs.layout.tabs.flatMap((tab) => {
    const visible = visibleByTabId.get(tab.id);
    if (!visible && !mountCache.mountedTabIds.has(tab.id)) return [];
    const pane = visible?.id ?? paneIdForTabId(tab.id, tabs);
    return [
      <Pane
        key={`${mountCache.sessionId}:${tab.id}`}
        pane={pane}
        paneNumber={visible?.paneNumber ?? paneNumberByTabId.get(tab.id) ?? 0}
        primary={pane === primaryPaneId}
        titlebarEdgeRight={pane === titlebarRightPaneId}
        tabId={tab.id}
        route={parseRoute(tab.target)}
        active={Boolean(visible && tabs.layout.focusedPaneId === visible.id)}
        rect={visible?.rect ?? { left: 0, top: 0, width: 0, height: 0 }}
        hidden={!visible}
      />,
    ];
  });
  const emptyPanes = geometry.panes.flatMap((pane, index) =>
    pane.tabId === null
      ? [
          <Pane
            key={`empty:${pane.id}`}
            pane={pane.id}
            paneNumber={index + 1}
            primary={pane.id === primaryPaneId}
            titlebarEdgeRight={pane.id === titlebarRightPaneId}
            tabId={null}
            route={null}
            active={tabs.layout.focusedPaneId === pane.id}
            rect={pane.rect}
          />,
        ]
      : [],
  );

  return (
    <div
      className={`app${prefs.sidebarOpen ? '' : ' sidebar-collapsed'}${prefs.assistant && prefs.assistantOpen ? ' has-assistant' : ''}${ui.mobileSidebar ? ' mobile-sidebar-open' : ''}${ui.focusMode ? ' focus-mode' : ''}`}
    >
      <Sidebar />
      <div className="scrim" aria-hidden="true" onClick={() => setUi({ mobileSidebar: false })} />
      <main className="main">
        <TabBar />
        <div className={`panes${geometry.panes.length > 1 ? ' is-split' : ''}`}>
          {paneHosts}
          {emptyPanes}
          {geometry.splits.map(({ split, rect }) => (
            <SplitResizer key={split.id} split={split} rect={rect} />
          ))}
        </div>
      </main>
      {prefs.assistant && prefs.assistantOpen && desktop?.assistant && (
        <Suspense fallback={null}>
          <AssistantPanel />
        </Suspense>
      )}
      {ui.palette && <CommandPalette />}
      <Dialogs />
      <Toasts />
    </div>
  );
}
