import {
  CalendarCheck,
  Columns2,
  Copy,
  File,
  FileText,
  Globe,
  Hash,
  Home,
  Image as ImageIcon,
  MoveRight,
  Music,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { displayTitle } from '../../core/model';
import type { WorkspaceState } from '../../core/model';
import { extension as getExtension } from '../../core/vault/paths';
import { useTranslation } from '../i18n';
import type { TranslationKey, TranslationParams } from '../i18n';
import type { PaneTabInstance } from '../paneLayout';
import { navigate, parseRoute } from '../router';
import {
  duplicateTabToPane,
  getVisiblePanes,
  moveTabToPane,
  setActivePane,
  useTabs,
} from '../tabs';
import { setUi } from '../ui';
import { useWorkspace } from '../workspace';
import { PageIcon } from './Sidebar';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const MEDIA_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'mp4', 'webm', 'mov', 'mkv']);

export interface ChooserTabInfo {
  readonly tab: PaneTabInstance<string>;
  readonly title: string;
  readonly typeLabelKey: TranslationKey;
  readonly originLabel: string;
  readonly isVisible: boolean;
  readonly assignedPaneNumber: number | null;
  readonly subtitle: string | null;
  readonly icon: React.ReactNode;
  readonly isNote: boolean;
}

export function describeTabForChooser(
  tab: PaneTabInstance<string>,
  state: WorkspaceState,
  visibleLeaves: readonly { readonly id: string; readonly tabId: string | null }[],
  t: (key: TranslationKey, params?: TranslationParams) => string,
): ChooserTabInfo {
  const route = parseRoute(tab.target);
  const assignedIndex = visibleLeaves.findIndex((leaf) => leaf.tabId === tab.id);
  const isVisible = assignedIndex >= 0;
  const assignedPaneNumber = isVisible ? assignedIndex + 1 : null;
  const originLabel = isVisible
    ? t('paneLayout.paneNumber', { number: assignedIndex + 1 })
    : t('paneLayout.tabAvailable');

  let title: string;
  let subtitle: string | null = null;
  let typeLabelKey: TranslationKey;
  let icon: React.ReactNode;
  let isNote = false;

  switch (route.name) {
    case 'page': {
      isNote = true;
      typeLabelKey = 'paneLayout.tabTypeNote';
      const page = state.pages[route.id];
      if (page) {
        title = displayTitle(page);
        subtitle = page.dailyDate ? page.dailyDate : null;
        icon = <PageIcon page={page} />;
      } else {
        title = t('tabs.missingPage');
        icon = <FileText size={16} />;
      }
      break;
    }
    case 'home': {
      title = t('settings.general.startPages.home');
      typeLabelKey = 'paneLayout.tabTypeHome';
      icon = <Home size={16} />;
      break;
    }
    case 'file': {
      const ext = getExtension(route.path ?? '').toLowerCase();
      title = route.path?.split('/').at(-1) || t('fileViewer.title');
      subtitle = route.path ?? null;
      if (IMAGE_EXTENSIONS.has(ext)) {
        typeLabelKey = 'paneLayout.tabTypeImage';
        icon = <ImageIcon size={16} />;
      } else if (ext === 'pdf') {
        typeLabelKey = 'paneLayout.tabTypePdf';
        icon = <FileText size={16} />;
      } else if (MEDIA_EXTENSIONS.has(ext)) {
        typeLabelKey = 'paneLayout.tabTypeMedia';
        icon = <Music size={16} />;
      } else {
        typeLabelKey = 'paneLayout.tabTypeFile';
        icon = <File size={16} />;
      }
      break;
    }
    case 'url': {
      title = route.url ? new URL(route.url).host : t('resourceTarget.invalidUrlTitle');
      subtitle = route.url ?? null;
      typeLabelKey = 'paneLayout.tabTypeUrl';
      icon = <Globe size={16} />;
      break;
    }
    case 'tasks': {
      title = t('sidebar.tasks');
      typeLabelKey = 'paneLayout.tabTypeTasks';
      icon = <CalendarCheck size={16} />;
      break;
    }
    case 'tags':
    case 'tag': {
      title = route.name === 'tag' ? `#${route.tag}` : t('sidebar.tags');
      typeLabelKey = 'paneLayout.tabTypeTags';
      icon = <Hash size={16} />;
      break;
    }
    case 'search': {
      title = route.query ? `“${route.query}”` : t('common.search');
      typeLabelKey = 'paneLayout.tabTypeSearch';
      icon = <Search size={16} />;
      break;
    }
    default: {
      title = t('settings.general.startPages.home');
      typeLabelKey = 'paneLayout.tabTypeOther';
      icon = <Columns2 size={16} />;
    }
  }

  return {
    tab,
    title,
    typeLabelKey,
    originLabel,
    isVisible,
    assignedPaneNumber,
    subtitle,
    icon,
    isNote,
  };
}

export function PaneEmptyChooser({
  paneId,
  paneNumber,
}: {
  paneId: string;
  paneNumber: number;
}) {
  const { t } = useTranslation();
  const tabsState = useTabs();
  const workspaceState = useWorkspace();
  const [filter, setFilter] = useState('');

  const visibleLeaves = useMemo(() => getVisiblePanes(tabsState), [tabsState]);

  const items = useMemo(() => {
    return tabsState.layout.tabs.map((tab) =>
      describeTabForChooser(tab, workspaceState, visibleLeaves, t),
    );
  }, [tabsState.layout.tabs, workspaceState, visibleLeaves, t]);

  const filteredItems = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.originLabel.toLowerCase().includes(q),
    );
  }, [items, filter]);

  const handleChoose = (item: ChooserTabInfo) => {
    moveTabToPane(item.tab.id, paneId);
  };

  const handleDuplicate = (item: ChooserTabInfo) => {
    duplicateTabToPane(item.tab.id, paneId);
  };

  return (
    <div
      className="pane-empty-surface"
      data-pane-empty-chooser={paneId}
      role="region"
      aria-label={t('paneLayout.emptyPaneTitle')}
    >
      <div className="pane-empty-header">
        <div className="pane-empty-badge">
          <Columns2 size={20} aria-hidden="true" />
        </div>
        <h2 className="pane-empty-title">
          {t('paneLayout.emptyPaneTitle')} · {t('paneLayout.paneNumber', { number: paneNumber })}
        </h2>
        <p className="pane-empty-hint">{t('paneLayout.emptyPaneHint')}</p>
      </div>

      {items.length > 3 && (
        <div className="pane-empty-filter-wrapper">
          <Search size={14} className="pane-empty-filter-icon" aria-hidden="true" />
          <input
            type="search"
            className="pane-empty-filter"
            placeholder={t('paneLayout.filterTabs')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label={t('paneLayout.filterTabs')}
          />
        </div>
      )}

      <div className="pane-empty-tabs-section">
        {items.length === 0 ? (
          <p className="pane-empty-empty-msg">{t('paneLayout.noOpenTabs')}</p>
        ) : filteredItems.length === 0 ? (
          <p className="pane-empty-empty-msg">{t('paneLayout.noMatchingTabs')}</p>
        ) : (
          <ul className="pane-empty-tab-list" role="listbox" aria-label={t('tabs.openTabsAria')}>
            {filteredItems.map((item) => (
              <li
                key={item.tab.id}
                role="option"
                aria-selected={false}
                className="pane-empty-tab-item"
                data-tab-id={item.tab.id}
                tabIndex={0}
                onClick={() => handleChoose(item)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleChoose(item);
                  }
                }}
              >
                <span className="pane-empty-tab-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <div className="pane-empty-tab-main">
                  <div className="pane-empty-tab-top">
                    <span className="pane-empty-tab-title">{item.title}</span>
                    <span className="pane-tab-badge">{t(item.typeLabelKey)}</span>
                    <span
                      className={`pane-tab-badge origin${item.isVisible ? ' is-visible' : ''}`}
                    >
                      {item.originLabel}
                    </span>
                  </div>
                  {item.subtitle && (
                    <div className="pane-empty-tab-subtitle" title={item.subtitle}>
                      {item.subtitle}
                    </div>
                  )}
                </div>
                <div className="pane-empty-tab-actions">
                  <button
                    type="button"
                    className="button small"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleChoose(item);
                    }}
                    title={
                      item.isVisible
                        ? t('paneLayout.moveToPane')
                        : t('paneLayout.assignToPane')
                    }
                  >
                    {item.isVisible ? (
                      <>
                        <MoveRight size={13} aria-hidden="true" />
                        <span>{t('paneLayout.moveToPane')}</span>
                      </>
                    ) : (
                      <>
                        <Plus size={13} aria-hidden="true" />
                        <span>{t('paneLayout.assignToPane')}</span>
                      </>
                    )}
                  </button>
                  {item.isVisible && item.isNote && (
                    <button
                      type="button"
                      className="button small secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDuplicate(item);
                      }}
                      title={t('paneLayout.openSecondInstance')}
                    >
                      <Copy size={13} aria-hidden="true" />
                      <span>{t('paneLayout.openSecondInstance')}</span>
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="pane-empty-quick-actions">
        <button
          type="button"
          className="button small tertiary"
          onClick={() => navigate({ name: 'home' }, { pane: paneId })}
        >
          <Home size={14} aria-hidden="true" />
          <span>{t('paneLayout.quickOpenHome')}</span>
        </button>
        <button
          type="button"
          className="button small tertiary"
          onClick={() => {
            setActivePane(paneId);
            setUi({ palette: true });
          }}
        >
          <Sparkles size={14} aria-hidden="true" />
          <span>{t('paneLayout.quickSearch')}</span>
        </button>
      </div>
    </div>
  );
}
