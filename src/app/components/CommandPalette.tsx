import { CornerDownLeft, FilePlus, FileText, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { dialogOpened } from '../platform/desktop';
import { displayTitle } from '../../core/model';
import { foldText, searchWorkspace } from '../../core/search';
import type { SearchSnippet } from '../../core/search';
import { ancestorsOf, livePages } from '../../core/tree';
import { allActions, currentContext, formatShortcut, matchesShortcut } from '../actions';
import { useTranslation } from '../i18n';
import { createPage } from '../operations';
import { navigate, openPage as openPageInCurrentPane, routeHash } from '../router';
import type { Route } from '../router';
import { canOpenInEmptyPane, getTabs, paneSlots } from '../tabs';
import { getWorkspaceSessionGeneration } from '../workspace';
import { getUi, setUi, toast } from '../ui';
import type { PalettePaneScope } from '../ui';
import { useWorkspace } from '../workspace';
import { pageIcon } from './Sidebar';

interface Entry {
  key: string;
  group: string;
  title: string;
  icon: LucideIcon;
  detail?: string;
  snippet?: SearchSnippet | null;
  shortcut?: string;
  run: () => void;
}

const PANE_SCOPED_ACTION_IDS = new Set(['page.new']);

function paneScopeAvailable(scope: PalettePaneScope): boolean {
  if (getWorkspaceSessionGeneration() !== scope.sessionGeneration) return false;
  const tabs = getTabs();
  if (tabs.layout.topologyRevision !== scope.topologyRevision) return false;
  return paneSlots(tabs.layout).some((slot) => slot.paneId === scope.paneId && slot.tabId === null);
}

function navigateFromPaneScope(
  route: Route,
  scope: PalettePaneScope | null,
  unavailableMessage: string,
  capacityMessage: string,
): boolean {
  if (!scope) {
    navigate(route);
    return true;
  }
  if (!paneScopeAvailable(scope)) {
    toast(unavailableMessage, { tone: 'error' });
    return false;
  }
  if (!canOpenInEmptyPane(scope.paneId, routeHash(route))) {
    toast(capacityMessage, { tone: 'error' });
    return false;
  }
  navigate(route, { pane: scope.paneId });
  return true;
}

function isNoteOrDatabase(page: { kind: string }): boolean {
  return page.kind === 'page' || page.kind === 'database';
}

export function CommandPalette() {
  const { t, tAction } = useTranslation();
  const state = useWorkspace();
  const [query, setQuery] = useState('');
  // results follow a moment behind the typing in a big vault, so every key press shows at once
  const searched = useDeferredValue(query);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [palettePaneScope] = useState(() => getUi().palettePaneScope);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const closed = dialogOpened();
    return () => {
      closed();
      if (previousFocus.current?.isConnected) previousFocus.current.focus({ preventScroll: true });
    };
  }, []);

  const close = () => setUi({ palette: false, paletteForSide: false, palettePaneScope: null });

  const entries = useMemo<Entry[]>(() => {
    const navigateFromPalette = (route: Route): boolean => {
      return navigateFromPaneScope(
        route,
        palettePaneScope,
        t('tabs.paneNoLongerEmpty'),
        t('tabs.paneAtCapacity'),
      );
    };
    const openPageFromPalette = (id: string, find: string | null = null) => {
      if (!palettePaneScope) {
        openPageInCurrentPane(id, find);
        return true;
      }
      return navigateFromPalette({ name: 'page', id, find, anchor: null });
    };
    const createPageFromPalette = (title?: string) => {
      if (!palettePaneScope) {
        createPage(title === undefined ? {} : { title });
        return;
      }
      if (!paneScopeAvailable(palettePaneScope)) {
        toast(t('tabs.paneNoLongerEmpty'), { tone: 'error' });
        return;
      }
      if (!canOpenInEmptyPane(palettePaneScope.paneId)) {
        toast(t('tabs.paneAtCapacity'), { tone: 'error' });
        return;
      }
      const id = createPage({ ...(title === undefined ? {} : { title }), open: false });
      if (!id) return;
      setUi({ focusTitle: id, mobileSidebar: false });
      openPageFromPalette(id);
    };
    const context = currentContext();
    const actionQuery = foldText(searched.trim().replace(/^>/, ''));
    const actions = allActions()
      .filter(
        (action) =>
          action.id !== 'search' &&
          (!palettePaneScope || PANE_SCOPED_ACTION_IDS.has(action.id)) &&
          (!action.enabled || action.enabled(context)),
      )
      .map((action) => ({
        action,
        title: tAction(action.id, action.label),
      }))
      .filter(
        ({ action, title }) =>
          !actionQuery ||
          foldText(`${title} ${action.label} ${action.keywords ?? ''} ${action.group}`).includes(actionQuery),
      )
      .map<Entry>(({ action, title }) => ({
        key: `action:${action.id}`,
        group: t('common.actions'),
        title,
        icon: action.icon,
        ...(action.shortcut && !palettePaneScope
          ? { shortcut: formatShortcut(action.shortcut) }
          : {}),
        run: () => {
          if (palettePaneScope && action.id === 'page.new') createPageFromPalette();
          else action.run(context);
        },
      }));

    // making a page is what the palette is most often opened for, so it comes first among the actions
    const newPage = actions.findIndex((entry) => entry.key === 'action:page.new');
    if (newPage > 0) actions.unshift(...actions.splice(newPage, 1));

    if (searched.trim().startsWith('>')) return actions;

    if (!searched.trim()) {
      const recent = livePages(state.pages)
        .filter((page) => !palettePaneScope || isNoteOrDatabase(page))
        .filter((page) => page.lastOpenedAt !== null)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        .slice(0, 6)
        .map<Entry>((page) => ({
          key: `page:${page.id}`,
          group: t('actions.groups.recent'),
          title: displayTitle(page),
          icon: pageIcon(page),
          detail: ancestorsOf(state.pages, page.id).reverse().map(displayTitle).join(' / '),
          run: () => openPageFromPalette(page.id),
        }));
      // and above the recent pages before anything is typed
      const [first, ...rest] = actions;
      return first?.key === 'action:page.new'
        ? [{ ...first, group: t('actions.groups.create') }, ...recent, ...rest]
        : [...recent, ...actions];
    }

    const searchResults = searchWorkspace(state, searched, 30);
    const pages = searchResults
      .filter((result) => !palettePaneScope || isNoteOrDatabase(result.page))
      .map<Entry>((result) => ({
        key: `page:${result.page.id}`,
        group: t('actions.groups.pages'),
        title: displayTitle(result.page),
        icon: result.page ? pageIcon(result.page) : FileText,
        detail: result.path.join(' / '),
        snippet: result.titleMatch ? null : result.snippet,
        run: () => openPageFromPalette(result.page.id, result.titleMatch ? null : result.firstMatch),
      }));
    const everywhere: Entry = {
      key: 'search:all',
      group: t('actions.groups.pages'),
      title: t('actions.searchEverywhere', { query: searched.trim() }),
      icon: Search,
      shortcut: formatShortcut('Mod+Enter'),
      run: () => navigateFromPalette({ name: 'search', query: searched.trim() }),
    };
    // a page that is not there yet is made from what was typed, so the palette finds or makes a page
    const title = searched.trim();
    const exists = searchResults.some(
      (result) => foldText(displayTitle(result.page)) === foldText(title),
    );
    const create: Entry[] = exists
      ? []
      : [
          {
            key: 'page:create',
            group: t('actions.groups.pages'),
            title: t('actions.createNamed', { query: title }),
            icon: FilePlus,
            run: () => createPageFromPalette(title),
          },
        ];
    return [...pages, ...create, everywhere, ...actions.slice(0, 5)];
  }, [searched, state, t, tAction, palettePaneScope]);

  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActive(0);
  }

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    entry.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (
      palettePaneScope &&
      allActions().some(
        (action) =>
          action.id !== 'search' &&
          action.shortcut &&
          matchesShortcut(event.nativeEvent, action.shortcut),
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(entries.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && query.trim()) {
      // every result, with every place it matched, in a view of its own
      event.preventDefault();
      choose({
        key: 'search:keyboard',
        group: '',
        title: '',
        icon: Search,
        run: () =>
          navigateFromPaneScope(
            { name: 'search', query: query.trim() },
            palettePaneScope,
            t('tabs.paneNoLongerEmpty'),
            t('tabs.paneAtCapacity'),
          ),
      });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(entries[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const activeEntry = entries[active];

  return (
    <div
      className="dialog-backdrop palette-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('actions.paletteAria')}>
        <div className="palette-input-row">
          <Search size={18} strokeWidth={1.75} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder={t(
              getUi().paletteForSide ? 'actions.chooseSidePlaceholder' : 'actions.searchPlaceholder',
            )}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={activeEntry ? `palette-${active}` : undefined}
            aria-autocomplete="list"
            spellCheck={false}
          />
        </div>
        <div className="palette-results" id="palette-results" role="listbox" ref={listRef}>
          {entries.length === 0 && <div className="palette-empty">{t('actions.noResults')}</div>}
          {entries.map((entry, index) => {
            const Icon = entry.icon;
            const showGroup = entry.group !== entries[index - 1]?.group;
            return (
              <div key={entry.key}>
                {showGroup && <div className="menu-section">{entry.group}</div>}
                <div
                  id={`palette-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className="palette-item"
                  onMouseMove={() => index !== active && setActive(index)}
                  onClick={() => choose(entry)}
                >
                  <Icon size={16} strokeWidth={1.75} className="palette-item-icon" />
                  <div className="palette-item-text">
                    <div className="palette-item-title">
                      {entry.title}
                      {entry.detail && <span className="palette-item-detail">{entry.detail}</span>}
                    </div>
                    {entry.snippet && (
                      <div className="palette-snippet">
                        {entry.snippet.before}
                        <mark>{entry.snippet.match}</mark>
                        {entry.snippet.after}
                      </div>
                    )}
                  </div>
                  {entry.shortcut && <kbd className="kbd">{entry.shortcut}</kbd>}
                  {index === active && !entry.shortcut && (
                    <CornerDownLeft size={14} className="palette-enter" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-footer">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> {t('actions.footer.toMove')}
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> {t('actions.footer.toOpen')}
          </span>
          {!palettePaneScope && (
            <span>
              <kbd className="kbd">{formatShortcut('Mod+Enter')}</kbd> {t('actions.footer.forEveryResult')}
            </span>
          )}
          <span>
            <kbd className="kbd">Esc</kbd> {t('actions.footer.toClose')}
          </span>
        </div>
      </div>
    </div>
  );
}
