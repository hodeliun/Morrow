import {
  ArrowDownUp,
  ArrowDown,
  ArrowUp,
  Calculator,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  EyeOff,
  Filter,
  GalleryVerticalEnd,
  Info,
  LayoutList,
  Maximize2,
  Plus,
  Paintbrush,
  Search,
  Settings2,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { computePosition, flip, offset, shift } from '@floating-ui/dom';
import type { LucideIcon } from 'lucide-react';
import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { dateKey } from '../../../core/daily';
import { planColumnDuplicate, planColumnDuplicateUndo, snapshotColumnDuplicate } from '../../../core/columnDuplicate';
import {
  bindPageFormulaReferences,
  filterOpsFor,
  calendarDayForRow,
  conditionalFormatForCell,
  conditionalFormatForRow,
  formatDisplayValue,
  groupRows,
  propType,
  rowsOf,
  TITLE_PROP,
  VIEW_LABELS,
  visibleRows,
  newView,
  summarizeProperty,
  valueOf,
} from '../../../core/database';
import { BACKGROUND_HEX, COLORS, displayTitle, PROP_TYPES, VIEW_TYPES } from '../../../core/model';
import { unclaimedKeys } from '../../../core/properties';
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../../core/migrations';
import type {
  DocNode,
  DatabaseDef,
  FilterOp,
  FilterRule,
  FilterGroup,
  ConditionalFormatRule,
  ColorName,
  PageId,
  PageMeta,
  PropDef,
  PropType,
  PropValue,
  ViewDef,
  ViewType,
  SummaryOperation,
} from '../../../core/model';
import { fileUrl } from '../../platform/attachments';
import { newId } from '../../platform/files';
import { openPage } from '../../router';
import { getState, run, runAll, useWorkspace } from '../../workspace';
import { Menu } from '../Menu';
import { Popover } from '../Popover';
import { PageGlyph } from '../Emoji';
import { PageIcon } from '../Sidebar';
import { addColumnsFromPages, createRow, setValue, updateDatabase, updateView } from './data';
import { Chip, DraftInput, NewProperty, PropertyDisplay, PropertyInput } from './PropertyValue';
import { PropertySettings } from './PropertySettings';
import { TableActionRecoveryNotice } from './TableActionCell';
import { dateLocale, getLocale, t, tp } from '../../i18n';
import { colorLabel, filterLabel, propLabel, viewLabel, viewName } from '../../i18n/labels';
import { durationUnitFactor, isNumericPropertyType } from '../../../core/typedValues';
import { linkedViewReferences } from '../../../core/linkedViews';
import { namedControlIdentifier } from '../../../core/controls';
import { ViewChangeContext } from './viewContext';
import { insertPropertyNear } from './columnActions';
import type { ColumnInsertPosition } from './columnActions';
import { reservedPropertyName } from '../../../core/vault/pageFile';
import { toast } from '../../ui';

const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: Columns3,
  calendar: Calendar,
  list: LayoutList,
  gallery: GalleryVerticalEnd,
};

function summaryLabel(operation: SummaryOperation): string {
  const keys: Record<SummaryOperation, Parameters<typeof t>[0]> = {
    sum: 'database.summarySum',
    average: 'database.summaryAverage',
    count: 'database.summaryCount',
    min: 'database.summaryMinimum',
    max: 'database.summaryMaximum',
  };
  return t(keys[operation]);
}

const viewKey = (id: PageId) => `morrow.view.${id}`;

function filterDateTimeLocal(value: string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ruleValueForInput(
  value: PropValue,
  prop: PropDef | undefined,
  type: ReturnType<typeof propType>,
): string {
  if (prop && isNumericPropertyType(prop.type) && typeof value === 'number') {
    const displayValue =
      prop.type === 'percent'
        ? value * 100
        : prop.type === 'duration'
          ? value / durationUnitFactor(prop.format?.durationUnit ?? 'minutes')
          : value;
    return String(displayValue);
  }
  if (
    (type === 'datetime' || type === 'createdTime' || type === 'lastEditedTime') &&
    (typeof value === 'string' || typeof value === 'number')
  )
    return filterDateTimeLocal(value);
  return value === null ? '' : String(value);
}

function ruleValueFromInput(
  raw: string,
  previous: PropValue,
  prop: PropDef | undefined,
  type: ReturnType<typeof propType>,
): PropValue {
  if (!raw) return null;
  if (prop && isNumericPropertyType(prop.type)) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return previous;
    if (prop.type === 'percent') return parsed * 0.01;
    if (prop.type === 'duration') return parsed * durationUnitFactor(prop.format?.durationUnit ?? 'minutes');
    return parsed;
  }
  if (type === 'datetime' || type === 'createdTime' || type === 'lastEditedTime') {
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return previous;
    return type === 'datetime' ? date.toISOString() : date.getTime();
  }
  return raw;
}

function readViewChoice(id: PageId): string | null {
  try {
    return localStorage.getItem(viewKey(id));
  } catch {
    return null;
  }
}

function filterGroupsForView(view: ViewDef): FilterGroup[] {
  if (view.filterGroups?.length) return view.filterGroups;
  return view.filters.length ? [{ id: 'legacy', logic: 'and', filters: view.filters }] : [];
}

function withFilterGroups(view: ViewDef, filterGroups: FilterGroup[]): ViewDef {
  return { ...view, filters: [], filterGroups };
}

function orderedProperties(database: DatabaseDef, view: ViewDef): PropDef[] {
  const order = view.order ?? [];
  return database.properties
    .map((prop, index) => ({ prop, index }))
    .sort((a, b) => {
      const aOrder = order.indexOf(a.prop.id);
      const bOrder = order.indexOf(b.prop.id);
      if (aOrder >= 0 || bOrder >= 0) {
        if (aOrder < 0) return 1;
        if (bOrder < 0) return -1;
        if (aOrder !== bOrder) return aOrder - bOrder;
      }
      return a.index - b.index;
    })
    .map(({ prop }) => prop);
}

function contrastText(color: ColorName): string {
  const hex = BACKGROUND_HEX[color];
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255) ?? [1, 1, 1];
  const weights = [0.2126, 0.7152, 0.0722];
  const luminance = channels.reduce((total, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * weights[index]!;
  }, 0);
  return luminance > 0.45 ? '#202124' : '#ffffff';
}

function conditionalColorStyle(color: ColorName): CSSProperties {
  const foreground = contrastText(color);
  // Cell editors and display controls use theme variables rather than inherited color.
  // Scope those variables to the colored cell/card so dark-mode text stays readable.
  return {
    backgroundColor: BACKGROUND_HEX[color],
    color: foreground,
    '--text': foreground,
    '--text-muted': foreground,
    '--text-faint': foreground,
  } as CSSProperties;
}

function useViewUpdater(dbId: PageId, viewId: string) {
  const linkedUpdate = useContext(ViewChangeContext);
  return (change: (view: ViewDef) => ViewDef) =>
    linkedUpdate ? linkedUpdate(change) : updateView(dbId, viewId, change);
}

type QuickFilterDraft = { rule: FilterRule; enabled: boolean };
const EMPTY_QUICK_FILTERS: QuickFilterDraft[] = [];

export function DatabaseView({
  page,
  editable,
  hostPageId,
  embeddedView,
  onEmbeddedViewChange,
}: {
  page: PageMeta;
  editable: boolean;
  hostPageId?: PageId;
  embeddedView?: ViewDef;
  onEmbeddedViewChange?: (change: (view: ViewDef) => ViewDef) => void;
}) {
  const state = useWorkspace();
  const database = useMemo(() => page.database ?? { properties: [], views: [] }, [page.database]);
  const canEdit = editable && !database.unsupportedProperties?.length;
  const [viewId, setViewId] = useState<string | null>(() => readViewChoice(page.id));
  const view =
    embeddedView ?? database.views.find((candidate) => candidate.id === viewId) ?? database.views[0] ?? null;
  const [quickFiltersByView, setQuickFiltersByView] = useState<Record<string, QuickFilterDraft[]>>({});
  const quickFilters = view ? (quickFiltersByView[view.id] ?? EMPTY_QUICK_FILTERS) : EMPTY_QUICK_FILTERS;
  const allRows = useMemo(() => rowsOf(state, page.id), [state, page.id]);
  const rows = useMemo(
    () =>
      view
        ? visibleRows(
            allRows,
            view,
            database,
            state,
            quickFilters.filter((draft) => draft.enabled).map((draft) => draft.rule),
          )
        : allRows,
    [allRows, view, database, state, quickFilters],
  );
  const [tabMenu, setTabMenu] = useState<{ view: ViewDef; anchor: HTMLElement } | null>(null);
  const [addMenu, setAddMenu] = useState<HTMLElement | null>(null);
  const [filterRequest, setFilterRequest] = useState<{ propId: string; token: string } | null>(null);

  const choose = (id: string) => {
    setViewId(id);
    try {
      localStorage.setItem(viewKey(page.id), id);
    } catch {
      // the choice is only remembered for convenience
    }
  };

  // a database always has at least one view
  useEffect(() => {
    if (!embeddedView && canEdit && database.views.length === 0)
      updateDatabase(page.id, (current) => ({ ...current, views: [newView('table', current, newId)] }));
  }, [canEdit, database.views.length, embeddedView, page.id]);

  if (!view)
    return database.unsupportedProperties?.length ? (
      <section className="database" aria-label={t('sidebar.database')}>
        <p className="db-readonly-note" role="status">
          {t('database.unsupportedSchema')}
        </p>
      </section>
    ) : null;
  const visible = orderedProperties(database, view).filter((prop) => !view.hidden.includes(prop.id));
  const linkedViews = !embeddedView ? linkedViewReferences(state, page.id) : [];

  return (
    <ViewChangeContext.Provider value={embeddedView && onEmbeddedViewChange ? onEmbeddedViewChange : null}>
      <section
        className={`database${embeddedView ? ' is-linked-view' : ''}`}
        aria-label={t('sidebar.database')}
      >
        {database.unsupportedProperties?.length ? (
          <p className="db-readonly-note" role="status">
            {t('database.unsupportedSchema')}
          </p>
        ) : null}
        <TableActionRecoveryNotice dbId={page.id} />
        <div className="db-bar">
          {!embeddedView && (
            <div className="db-tabs" role="tablist" aria-label={t('database.views')}>
              {database.views.map((candidate) => {
                const Icon = VIEW_ICONS[candidate.type];
                return (
                  <button
                    key={candidate.id}
                    type="button"
                    role="tab"
                    aria-selected={candidate.id === view.id}
                    className={`db-tab${candidate.id === view.id ? ' is-active' : ''}`}
                    onClick={() => choose(candidate.id)}
                    onContextMenu={(event) => {
                      if (!canEdit) return;
                      event.preventDefault();
                      setTabMenu({ view: candidate, anchor: event.currentTarget });
                    }}
                    onDoubleClick={(event) =>
                      canEdit && setTabMenu({ view: candidate, anchor: event.currentTarget })
                    }
                  >
                    <Icon size={14} /> {viewName(candidate)}
                  </button>
                );
              })}
              {canEdit && (
                <button
                  type="button"
                  className="icon-button small"
                  aria-label={t('database.addAView')}
                  onClick={(event) => setAddMenu(event.currentTarget)}
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
          )}
          <Toolbar
            dbId={page.id}
            scopePageId={hostPageId ?? page.id}
            database={database}
            view={view}
            rows={allRows}
            editable={canEdit}
            requestedFilter={filterRequest}
          />
        </div>
        <QuickFilterBar
          database={database}
          drafts={quickFilters}
          onChange={(drafts) => setQuickFiltersByView((current) => ({ ...current, [view.id]: drafts }))}
        />
        {!embeddedView && canEdit && <ColumnSuggestion dbId={page.id} database={database} rows={allRows} />}

        {view.type === 'table' && (
          <TableView
            dbId={page.id}
            database={database}
            view={view}
            rows={rows}
            props={visible}
            editable={canEdit}
            onRequestFilter={(propId) => setFilterRequest({ propId, token: newId() })}
          />
        )}
        {view.type === 'board' && (
          <BoardView dbId={page.id} database={database} view={view} rows={rows} editable={canEdit} />
        )}
        {view.type === 'calendar' && (
          <CalendarView dbId={page.id} database={database} view={view} rows={rows} editable={canEdit} />
        )}
        {view.type === 'list' && <ListView rows={rows} props={visible} database={database} />}
        {view.type === 'gallery' && <GalleryView rows={rows} database={database} view={view} />}
        {allRows.length > 0 && rows.length === 0 && (
          <p className="db-empty-results muted small" role="status">
            {t('database.noMatchingRows')}
          </p>
        )}
        {view.type !== 'table' && canEdit && (
          <button type="button" className="db-new-row" onClick={() => newRowAndOpen(page.id, {})}>
            <Plus size={14} /> {t('database.new')}
          </button>
        )}
        <p className="db-count muted small">
          {rows.length === allRows.length
            ? tp('database.rows', rows.length)
            : t('database.rowsOf', { count: rows.length, total: allRows.length })}
        </p>

        {!embeddedView && linkedViews.length > 0 && (
          <nav className="db-linked-views" aria-label={t('database.linkedViews')}>
            <span className="muted small">{t('database.linkedViews')}</span>
            {linkedViews.map((reference, index) => {
              const host = state.pages[reference.hostPageId];
              return host ? (
                <button
                  key={`${reference.hostPageId}:${reference.blockId ?? index}`}
                  type="button"
                  onClick={() => openPage(host.id)}
                >
                  {displayTitle(host)} · {reference.viewName || t('database.linkedView')}
                </button>
              ) : null;
            })}
          </nav>
        )}

        {!embeddedView && addMenu && (
          <Menu
            anchor={addMenu}
            label={t('database.addAView')}
            onClose={() => setAddMenu(null)}
            entries={VIEW_TYPES.map((type) => ({
              label: viewLabel(type),
              icon: VIEW_ICONS[type],
              onSelect: () => {
                const created = newView(type, database, newId);
                if (
                  updateDatabase(page.id, (current) => ({ ...current, views: [...current.views, created] }))
                )
                  choose(created.id);
              },
            }))}
          />
        )}
        {!embeddedView && tabMenu && (
          <ViewSettings
            dbId={page.id}
            database={database}
            view={tabMenu.view}
            anchor={tabMenu.anchor}
            onClose={() => setTabMenu(null)}
          />
        )}
      </section>
    </ViewChangeContext.Provider>
  );
}

function newRowAndOpen(dbId: PageId, values: Record<string, PropValue>): void {
  const id = createRow(dbId, values);
  if (id) openPage(id);
}

function ViewSettings({
  dbId,
  database,
  view,
  anchor,
  onClose,
}: {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const saveView = useViewUpdater(dbId, view.id);
  return (
    <Popover anchor={anchor} onClose={onClose} label={t('database.viewSettings')}>
      <label className="field">
        <span>{t('database.name')}</span>
        <DraftInput
          type="text"
          label={t('database.viewName')}
          className="text-input small"
          value={view.name}
          editable
          onCommit={(name) =>
            saveView((current) => ({
              ...current,
              name: name.trim() || VIEW_LABELS[current.type],
            }))
          }
        />
      </label>
      <label className="field">
        <span>{t('slash.sections.layout')}</span>
        <select
          className="text-input small"
          value={view.type}
          onChange={(event) =>
            saveView((current) => {
              const type = event.target.value as ViewType;
              const fresh = newView(type, database, () => current.id);
              return {
                ...current,
                type,
                groupBy: current.groupBy ?? fresh.groupBy,
                dateProp: current.dateProp ?? fresh.dateProp,
              };
            })
          }
        >
          {VIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {viewLabel(type)}
            </option>
          ))}
        </select>
      </label>
      <div className="popover-actions">
        <button
          type="button"
          className="button small"
          onClick={() => {
            updateDatabase(dbId, (current) => ({
              ...current,
              views: [...current.views, { ...view, id: newId(), name: `${view.name} copy` }],
            }));
            onClose();
          }}
        >
          {t('pageMenu.duplicate')}
        </button>
        <button
          type="button"
          className="button small danger"
          disabled={database.views.length <= 1}
          onClick={() => {
            updateDatabase(dbId, (current) => ({
              ...current,
              views: current.views.filter((candidate) => candidate.id !== view.id),
            }));
            onClose();
          }}
        >
          <Trash2 size={13} /> {t('database.deleteView')}
        </button>
      </div>
    </Popover>
  );
}

function QuickFilterBar({
  database,
  drafts,
  onChange,
}: {
  database: DatabaseDef;
  drafts: QuickFilterDraft[];
  onChange: (drafts: QuickFilterDraft[]) => void;
}) {
  const state = useWorkspace();
  const names = [{ id: TITLE_PROP, name: t('database.name') }, ...database.properties];
  const activeCount = drafts.filter((draft) => draft.enabled).length;
  const updateDraft = (id: string, change: Partial<FilterRule>, enabled?: boolean) =>
    onChange(
      drafts.map((draft) =>
        draft.rule.id === id
          ? { ...draft, rule: { ...draft.rule, ...change }, enabled: enabled ?? draft.enabled }
          : draft,
      ),
    );

  return (
    <section
      className={`db-quick-filters${activeCount ? ' is-active' : ''}`}
      aria-label={t('database.quickFilters')}
    >
      <header className="db-quick-filters-head">
        <div className="db-quick-filters-copy">
          <div className="db-quick-filters-title">
            <Filter size={14} />
            <strong>{t('database.quickFilters')}</strong>
            {activeCount > 0 && (
              <span className="db-quick-filters-count" role="status">
                {t('database.activeQuickFilters', { count: activeCount })}
              </span>
            )}
          </div>
          <span className="muted small">{t('database.quickFiltersHint')}</span>
        </div>
        <div className="db-quick-filters-actions">
          <button
            type="button"
            className="button small"
            onClick={() =>
              onChange([
                ...drafts,
                {
                  rule: { id: newId(), prop: TITLE_PROP, op: 'contains', value: '' },
                  enabled: false,
                },
              ])
            }
          >
            <Plus size={13} /> {t('database.addQuickFilter')}
          </button>
          {drafts.length > 0 && (
            <button type="button" className="link-button" onClick={() => onChange([])}>
              {t('database.clearQuickFilters')}
            </button>
          )}
        </div>
      </header>
      {drafts.map((draft) => {
        const { rule } = draft;
        const type = propType(database, rule.prop) ?? 'text';
        const prop = database.properties.find((candidate) => candidate.id === rule.prop);
        const ops = filterOpsFor(type === 'title' ? 'text' : type);
        const isTimestamp = type === 'createdTime' || type === 'lastEditedTime';
        const needsValue = !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
        const relationDatabaseId = prop?.type === 'relation' ? prop.relation?.targetDatabaseId : null;
        const relationDatabase = relationDatabaseId ? state.pages[relationDatabaseId] : undefined;
        const relationRows = relationDatabase?.database ? rowsOf(state, relationDatabase.id) : [];
        const noValueOperation = (op: FilterOp) => ['empty', 'notEmpty', 'checked', 'unchecked'].includes(op);
        return (
          <div className={`db-quick-filter${draft.enabled ? ' is-active' : ''}`} key={rule.id}>
            <select
              className="text-input small"
              aria-label={t('database.property')}
              value={rule.prop}
              onChange={(event) => {
                const nextType = propType(database, event.target.value) ?? 'text';
                updateDraft(
                  rule.id,
                  {
                    prop: event.target.value,
                    op: filterOpsFor(nextType === 'title' ? 'text' : nextType)[0]!,
                    value: null,
                  },
                  false,
                );
              }}
            >
              {names.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              className="text-input small"
              aria-label={t('database.condition')}
              value={rule.op}
              onChange={(event) => {
                const op = event.target.value as FilterOp;
                updateDraft(rule.id, { op, value: null }, noValueOperation(op));
              }}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {filterLabel(op)}
                </option>
              ))}
            </select>
            {needsValue &&
              (prop && (prop.type === 'select' || prop.type === 'multiSelect') ? (
                <select
                  className="text-input small"
                  aria-label={t('database.value')}
                  value={String(rule.value ?? '')}
                  onChange={(event) => updateDraft(rule.id, { value: event.target.value }, true)}
                >
                  <option value="">{t('database.choose')}</option>
                  {prop.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              ) : prop?.type === 'relation' && relationDatabaseId ? (
                <select
                  className="text-input small"
                  aria-label={t('database.value')}
                  value={String(rule.value ?? '')}
                  onChange={(event) => updateDraft(rule.id, { value: event.target.value }, true)}
                >
                  <option value="">{t('database.choose')}</option>
                  {relationRows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {displayTitle(row)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="text-input small"
                  aria-label={t('database.value')}
                  type={
                    prop && isNumericPropertyType(prop.type)
                      ? 'number'
                      : isTimestamp || prop?.type === 'datetime'
                        ? 'datetime-local'
                        : prop?.type === 'date' || prop?.type === 'time'
                          ? prop.type
                          : 'text'
                  }
                  step={prop && isNumericPropertyType(prop.type) ? 'any' : undefined}
                  value={ruleValueForInput(rule.value, prop, type)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const value = raw === '' ? '' : ruleValueFromInput(raw, rule.value, prop, type);
                    updateDraft(rule.id, { value }, true);
                  }}
                />
              ))}
            <button
              type="button"
              className="icon-button tiny"
              aria-label={t('database.removeFilter')}
              onClick={() => onChange(drafts.filter((candidate) => candidate.rule.id !== rule.id))}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </section>
  );
}

type ToolPanel = 'filter' | 'sort' | 'properties' | 'layout' | 'summary' | 'format';

// the frontmatter keys rows already have but no column shows yet, such as the properties of notes that
// came from obsidian, offered once until they are added or dismissed
function ColumnSuggestion({
  dbId,
  database,
  rows,
}: {
  dbId: PageId;
  database: DatabaseDef;
  rows: PageMeta[];
}) {
  const keys = useMemo(() => unclaimedKeys(database, rows), [database, rows]);
  const storageKey = `morrow.columns-dismissed.${dbId}`;
  const [dismissed, setDismissed] = useState<string>(() => {
    try {
      return localStorage.getItem(storageKey) ?? '';
    } catch {
      return '';
    }
  });
  const signature = keys.join('\n');
  if (keys.length === 0 || dismissed === signature) return null;
  const names = keys.slice(0, 4).join(', ');
  const shown = keys.length > 4 ? t('database.andMore', { names, count: keys.length - 4 }) : names;
  return (
    <div className="db-suggest" role="note">
      <Columns3 size={14} />
      <span>{tp('database.suggestColumns', keys.length, { names: shown })}</span>
      <button type="button" className="button small" onClick={() => addColumnsFromPages(dbId, keys)}>
        {t('database.addAsColumns')}
      </button>
      <button
        type="button"
        className="icon-button tiny"
        aria-label={t('common.dismiss')}
        onClick={() => {
          setDismissed(signature);
          try {
            localStorage.setItem(storageKey, signature);
          } catch {
            // only a convenience
          }
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

function Toolbar({
  dbId,
  scopePageId,
  database,
  view,
  rows,
  editable,
  requestedFilter,
}: {
  dbId: PageId;
  scopePageId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  editable: boolean;
  requestedFilter: { propId: string; token: string } | null;
}) {
  const state = useWorkspace();
  const saveView = useViewUpdater(dbId, view.id);
  const unclaimed = useMemo(() => unclaimedKeys(database, rows), [database, rows]);
  const [panel, setPanel] = useState<{ kind: ToolPanel; anchor: HTMLElement } | null>(null);
  const open = (kind: ToolPanel) => (event: React.MouseEvent<HTMLElement>) =>
    setPanel({ kind, anchor: event.currentTarget });
  const names = [{ id: TITLE_PROP, name: t('database.name'), type: 'text' as const }, ...database.properties];
  const controls = state.pages[scopePageId]?.controls ?? [];
  const controlChoiceLabel = (control: (typeof controls)[number]) => {
    const foldedName = control.name.trim().toLocaleLowerCase();
    const duplicate = controls.filter((item) => item.name.trim().toLocaleLowerCase() === foldedName).length > 1;
    return duplicate ? `${control.name} · ${control.id.slice(-6)}` : control.name;
  };
  const groups = filterGroupsForView(view);
  const filterCount = groups.reduce((count, group) => count + group.filters.length, 0);
  const activeCount = filterCount + (view.search?.trim() ? 1 : 0);
  const updateGroups = (change: (groups: FilterGroup[]) => FilterGroup[]) =>
    saveView((current) => withFilterGroups(current, change(filterGroupsForView(current))));
  const filterButton = useRef<HTMLButtonElement>(null);
  const handledFilterRequest = useRef<string | null>(null);
  const updateGroupsRef = useRef(updateGroups);
  useEffect(() => {
    updateGroupsRef.current = updateGroups;
  });
  useEffect(() => {
    const anchor = filterButton.current;
    if (
      !requestedFilter ||
      handledFilterRequest.current === requestedFilter.token ||
      !anchor ||
      !database.properties.some((prop) => prop.id === requestedFilter.propId)
    )
      return;
    handledFilterRequest.current = requestedFilter.token;
    const type = propType(database, requestedFilter.propId) ?? 'text';
    const rule: FilterRule = {
      id: newId(),
      prop: requestedFilter.propId,
      op: filterOpsFor(type === 'title' ? 'text' : type)[0] ?? 'contains',
      value: null,
    };
    updateGroupsRef.current((current) =>
      current.length
        ? current.map((group, index) =>
            index === 0 ? { ...group, filters: [...group.filters, rule] } : group,
          )
        : [{ id: newId(), logic: 'and', filters: [rule] }],
    );
    setPanel({ kind: 'filter', anchor });
  }, [database, requestedFilter]);
  return (
    <div className="db-tools">
      <button
        ref={filterButton}
        type="button"
        className={`text-tool${filterCount ? ' is-active' : ''}`}
        onClick={open('filter')}
        disabled={!editable}
      >
        <Filter size={13} /> {t('database.filter')}
        {filterCount ? ` ${filterCount}` : ''}
      </button>
      <button
        type="button"
        className={`text-tool${view.sorts.length ? ' is-active' : ''}`}
        onClick={open('sort')}
        disabled={!editable}
      >
        <ArrowDownUp size={13} /> {t('database.sort')}
        {view.sorts.length ? ` ${view.sorts.length}` : ''}
      </button>
      <button type="button" className="text-tool" onClick={open('layout')} disabled={!editable}>
        <Settings2 size={13} /> {t('slash.sections.layout')}
      </button>
      <button type="button" className="text-tool" onClick={open('properties')}>
        <Eye size={13} /> {t('database.properties')}
      </button>
      <button type="button" className="text-tool" onClick={open('summary')} disabled={!editable}>
        <Calculator size={13} /> {t('database.summary')}
      </button>
      <button type="button" className="text-tool" onClick={open('format')} disabled={!editable}>
        <Paintbrush size={13} /> {t('database.conditionalFormatting')}
      </button>
      <label className="db-search">
        <Search size={13} aria-hidden="true" />
        <input
          type="search"
          className="text-input small"
          aria-label={t('database.searchRows')}
          placeholder={t('database.searchRows')}
          value={view.search ?? ''}
          disabled={!editable}
          onChange={(event) =>
            saveView((current) => ({ ...current, search: event.target.value.slice(0, 500) }))
          }
        />
      </label>
      {activeCount > 0 && (
        <div className="db-filter-state" role="status">
          <span>{t('database.activeFilters', { count: activeCount })}</span>
          <span className="muted small">{t('database.filteredRowsRemain')}</span>
          <button
            type="button"
            className="link-button"
            onClick={() => saveView((current) => ({ ...current, filters: [], filterGroups: [], search: '' }))}
          >
            {t('database.clearFilters')}
          </button>
        </div>
      )}
      {panel?.kind === 'filter' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.filters')}
          className="db-panel"
        >
          {groups.length === 0 && <p className="muted small">{t('database.noFilters')}</p>}
          {groups.length > 1 && (
            <label className="field">
              <span>{t('database.filterGroup')}</span>
              <select
                className="text-input small"
                value={view.filterGroupLogic ?? 'and'}
                onChange={(event) =>
                  saveView((current) => ({
                    ...current,
                    filterGroupLogic: event.target.value === 'or' ? 'or' : 'and',
                  }))
                }
              >
                <option value="and">{t('database.groupsMatchAll')}</option>
                <option value="or">{t('database.groupsMatchAny')}</option>
              </select>
            </label>
          )}
          {groups.map((group) => (
            <section className="db-filter-group" key={group.id}>
              <header className="db-filter-group-head">
                <select
                  className="text-input small"
                  aria-label={t('database.filterGroup')}
                  value={group.logic}
                  onChange={(event) =>
                    updateGroups((current) =>
                      current.map((item) =>
                        item.id === group.id
                          ? { ...item, logic: event.target.value === 'or' ? 'or' : 'and' }
                          : item,
                      ),
                    )
                  }
                >
                  <option value="and">{t('database.groupMatchAllRules')}</option>
                  <option value="or">{t('database.groupMatchAnyRule')}</option>
                </select>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.removeFilterGroup')}
                  onClick={() => updateGroups((current) => current.filter((item) => item.id !== group.id))}
                >
                  <X size={13} />
                </button>
              </header>
              {group.filters.map((rule) => {
                const formulaRule = rule.formula !== undefined;
                const type = propType(database, rule.prop) ?? 'text';
                const prop = database.properties.find((candidate) => candidate.id === rule.prop);
                const ops = filterOpsFor(type === 'title' ? 'text' : type);
                const isTimestamp = type === 'createdTime' || type === 'lastEditedTime';
                const filterValue = ruleValueForInput(rule.value, prop, type);
                const needsValue = !rule.controlRef && !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
                const boundControl = rule.controlRef
                  ? state.pages[rule.controlRef.pageId]?.controls.find((item) => item.id === rule.controlRef!.controlId)
                  : null;
                const change = (patch: Partial<typeof rule>) =>
                  updateGroups((current) =>
                    current.map((item) =>
                      item.id === group.id
                        ? {
                            ...item,
                            filters: item.filters.map((candidate) =>
                              candidate.id === rule.id ? { ...candidate, ...patch } : candidate,
                            ),
                          }
                        : item,
                    ),
                  );
                return (
                  <div key={rule.id} className="db-rule">
                    {formulaRule ? <div className="db-formula-filter">
                      <label className="field">
                        <span>{t('controls.formula')}</span>
                        <textarea
                          className="text-input small"
                          rows={3}
                          value={rule.formula ?? ''}
                          placeholder={t('controls.filterFormulaPlaceholder')}
                          onChange={(event) => {
                            const formula = event.target.value;
                            const formulaBindings = bindPageFormulaReferences(formula, scopePageId, state, dbId, rule.formulaBindings ?? []);
                            change({ formula, formulaBindings });
                          }}
                        />
                      </label>
                      <label className="field">
                        <span>{t('controls.insertReference')}</span>
                        <select className="text-input small" defaultValue="" onChange={(event) => {
                          const control = controls.find((item) => item.id === event.target.value);
                          if (!control) return;
                          const source = namedControlIdentifier(control.name);
                          const formula = rule.formula ?? '';
                          const start = formula.length + (formula.trim() ? 1 : 0);
                          const nextFormula = `${formula}${formula.trim() ? ' ' : ''}${source}`;
                          const formulaBindings = [
                            ...(rule.formulaBindings ?? []).filter((binding) => nextFormula.slice(binding.start, binding.end) === binding.source),
                            { kind: 'control' as const, pageId: scopePageId, controlId: control.id, start, end: start + source.length, source },
                          ];
                          change({ formula: nextFormula, formulaBindings });
                          event.target.value = '';
                        }}>
                          <option value="">{t('controls.chooseReference')}</option>
                          {controls.map((control) => <option key={control.id} value={control.id}>{controlChoiceLabel(control)}</option>)}
                        </select>
                      </label>
                      {rule.formulaBindings?.filter((binding) => binding.kind === 'ambiguous').map((binding) => (
                        <p className="named-data-diagnostic" key={`${binding.start}:${binding.end}`}>{t('controls.ambiguousReference', { name: binding.source })}</p>
                      ))}
                    </div> : <>
                    <select
                      className="text-input small"
                      aria-label={t('database.property')}
                      value={rule.prop}
                      onChange={(event) => {
                        const nextType = propType(database, event.target.value) ?? 'text';
                        change({
                          prop: event.target.value,
                          op: filterOpsFor(nextType === 'title' ? 'text' : nextType)[0]!,
                          value: null,
                          controlRef: undefined,
                        });
                      }}
                    >
                      {names.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className="text-input small"
                      aria-label={t('controls.selectControl')}
                      value={rule.controlRef ? `${rule.controlRef.pageId}:${rule.controlRef.controlId}` : ''}
                      onChange={(event) => {
                        if (!event.target.value) change({ controlRef: undefined });
                        else {
                          const [pageId, ...rest] = event.target.value.split(':');
                          change({ controlRef: { pageId: pageId!, controlId: rest.join(':') } });
                        }
                      }}
                    >
                      <option value="">{t('controls.directValue')}</option>
                      {boundControl && rule.controlRef && !controls.some((item) => item.id === rule.controlRef!.controlId) && <option value={`${rule.controlRef.pageId}:${rule.controlRef.controlId}`}>{t('controls.referenceControl', { name: `${boundControl.name} · ${boundControl.id.slice(-6)}` })}</option>}
                      {controls.map((control) => <option key={control.id} value={`${scopePageId}:${control.id}`}>{controlChoiceLabel(control)}</option>)}
                    </select>
                    {rule.controlRef && !boundControl && <p className="named-data-diagnostic">{t('controls.missingControl', { name: rule.controlRef.controlId })}</p>}
                    <select
                      className="text-input small"
                      aria-label={t('database.condition')}
                      value={rule.op}
                      onChange={(event) => change({ op: event.target.value as FilterOp })}
                    >
                      {ops.map((op) => (
                        <option key={op} value={op}>
                          {filterLabel(op)}
                        </option>
                      ))}
                    </select>
                    {needsValue &&
                      (prop && (prop.type === 'select' || prop.type === 'multiSelect') ? (
                        <select
                          className="text-input small"
                          aria-label={t('database.value')}
                          value={String(rule.value ?? '')}
                          onChange={(event) => change({ value: event.target.value || null })}
                        >
                          <option value="">{t('database.choose')}</option>
                          {prop.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="text-input small"
                          aria-label={t('database.value')}
                          type={
                            prop && isNumericPropertyType(prop.type)
                              ? 'number'
                              : isTimestamp || prop?.type === 'datetime'
                                ? 'datetime-local'
                                : prop?.type === 'date' || prop?.type === 'time'
                                  ? prop.type
                                  : 'text'
                          }
                          step={prop && isNumericPropertyType(prop.type) ? 'any' : undefined}
                          value={filterValue}
                          onChange={(event) =>
                            change({ value: ruleValueFromInput(event.target.value, rule.value, prop, type) })
                          }
                        />
                      ))}
                    </>}
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('database.removeFilter')}
                      onClick={() =>
                        updateGroups((current) =>
                          current.map((item) =>
                            item.id === group.id
                              ? {
                                  ...item,
                                  filters: item.filters.filter((candidate) => candidate.id !== rule.id),
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  updateGroups((current) =>
                    current.map((item) =>
                      item.id === group.id
                        ? {
                            ...item,
                            filters: [
                              ...item.filters,
                              { id: newId(), prop: TITLE_PROP, op: 'contains', value: '' },
                            ],
                          }
                        : item,
                    ),
                  )
                }
              >
                <Plus size={13} /> {t('database.addAFilter')}
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => updateGroups((current) => current.map((item) => item.id === group.id
                  ? { ...item, filters: [...item.filters, { id: newId(), prop: '$formula', op: 'is', value: null, formula: '', formulaBindings: [] }] }
                  : item))}
              >
                <Plus size={13} /> {t('controls.addFormulaFilter')}
              </button>
            </section>
          ))}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              updateGroups((current) =>
                current.length
                  ? [
                      ...current,
                      {
                        id: newId(),
                        logic: 'and',
                        filters: [{ id: newId(), prop: TITLE_PROP, op: 'contains', value: '' }],
                      },
                    ]
                  : [
                      {
                        id: newId(),
                        logic: 'and',
                        filters: [{ id: newId(), prop: TITLE_PROP, op: 'contains', value: '' }],
                      },
                    ],
              )
            }
          >
            <Plus size={13} /> {t('database.addFilterGroup')}
          </button>
        </Popover>
      )}
      {panel?.kind === 'sort' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.sorting')}
          className="db-panel"
        >
          {view.sorts.length === 0 && <p className="muted small">{t('database.noSorts')}</p>}
          {view.sorts.map((sort, index) => (
            <div key={`${sort.prop}-${index}`} className="db-rule db-sort-rule">
              <select
                className="text-input small"
                aria-label={t('database.sortBy')}
                value={sort.prop}
                onChange={(event) =>
                  saveView((current) => ({
                    ...current,
                    sorts: current.sorts.map((item, i) =>
                      i === index ? { ...item, prop: event.target.value } : item,
                    ),
                  }))
                }
              >
                {[
                  ...names,
                  { id: 'created', name: t('database.created') },
                  { id: 'updated', name: t('database.edited') },
                ].map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select
                className="text-input small"
                aria-label={t('database.direction')}
                value={sort.dir}
                onChange={(event) =>
                  saveView((current) => ({
                    ...current,
                    sorts: current.sorts.map((item, i) =>
                      i === index ? { ...item, dir: event.target.value === 'desc' ? 'desc' : 'asc' } : item,
                    ),
                  }))
                }
              >
                <option value="asc">{t('database.ascending')}</option>
                <option value="desc">{t('database.descending')}</option>
              </select>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={t('database.removeSort')}
                onClick={() =>
                  saveView((current) => ({
                    ...current,
                    sorts: current.sorts.filter((_item, i) => i !== index),
                  }))
                }
              >
                <X size={13} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              saveView((current) => ({
                ...current,
                sorts: [...current.sorts, { prop: TITLE_PROP, dir: 'asc' }],
              }))
            }
          >
            <Plus size={13} /> {t('database.addASort')}
          </button>
        </Popover>
      )}
      {panel?.kind === 'layout' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('slash.sections.layout')}
          className="db-panel"
        >
          <label className="field">
            <span>{t('slash.sections.layout')}</span>
            <select
              className="text-input small"
              value={view.type}
              onChange={(event) =>
                saveView((current) => {
                  const type = event.target.value as ViewType;
                  const fresh = newView(type, database, () => current.id);
                  return {
                    ...current,
                    type,
                    groupBy: current.groupBy ?? fresh.groupBy,
                    dateProp: current.dateProp ?? fresh.dateProp,
                  };
                })
              }
            >
              {VIEW_TYPES.map((type) => (
                <option key={type} value={type}>
                  {viewLabel(type)}
                </option>
              ))}
            </select>
          </label>
          {view.type === 'gallery' && (
            <label className="field">
              <span>{t('database.groupCardsBy')}</span>
              <select
                className="text-input small"
                value={view.groupBy ?? ''}
                onChange={(event) =>
                  saveView((current) => ({ ...current, groupBy: event.target.value || null }))
                }
              >
                <option value="">{t('database.none')}</option>
                {database.properties
                  .filter(
                    (prop) =>
                      ['select', 'multiSelect', 'checkbox', 'formula'].includes(prop.type) ||
                      prop.fillMode === 'calculated',
                  )
                  .map((prop) => (
                    <option key={prop.id} value={prop.id}>
                      {prop.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label className="field">
            {(view.type === 'board' || view.type === 'calendar') && (
              <>
                <span>{view.type === 'board' ? t('database.groupCardsBy') : t('database.placeRowsBy')}</span>
                <select
                  className="text-input small"
                  value={(view.type === 'board' ? view.groupBy : view.dateProp) ?? ''}
                  onChange={(event) =>
                    saveView((current) =>
                      current.type === 'board'
                        ? { ...current, groupBy: event.target.value || null }
                        : { ...current, dateProp: event.target.value || null },
                    )
                  }
                >
                  <option value="">{t('database.none')}</option>
                  {database.properties
                    .filter((prop) =>
                      view.type === 'board'
                        ? ['select', 'multiSelect', 'checkbox', 'formula'].includes(prop.type) ||
                          prop.fillMode === 'calculated'
                        : ['date', 'datetime', 'formula'].includes(prop.type) ||
                          prop.fillMode === 'calculated',
                    )
                    .map((prop) => (
                      <option key={prop.id} value={prop.id}>
                        {prop.name}
                      </option>
                    ))}
                </select>
              </>
            )}
          </label>
          {(view.type === 'board' || view.type === 'gallery') && (
            <>
              <label className="field">
                <span>{t('database.cardImage')}</span>
                <select
                  className="text-input small"
                  value={view.cardImageProp === undefined ? '__page' : (view.cardImageProp ?? 'none')}
                  onChange={(event) =>
                    saveView((current) => ({
                      ...current,
                      cardImageProp:
                        event.target.value === '__page'
                          ? undefined
                          : event.target.value === 'none'
                            ? null
                            : event.target.value,
                    }))
                  }
                >
                  <option value="__page">{t('database.usePageImage')}</option>
                  <option value="none">{t('database.noImage')}</option>
                  {database.properties
                    .filter((prop) => prop.type === 'image')
                    .map((prop) => (
                      <option key={prop.id} value={prop.id}>
                        {prop.name}
                      </option>
                    ))}
                </select>
              </label>
              <fieldset className="db-card-field-picker">
                <legend>{t('database.cardFields')}</legend>
                {database.properties.map((prop) => {
                  const selected = view.cardProperties
                    ? view.cardProperties.includes(prop.id)
                    : !view.hidden.includes(prop.id);
                  return (
                    <label key={prop.id}>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) =>
                          saveView((current) => {
                            const currentFields =
                              current.cardProperties ??
                              database.properties
                                .filter((item) => !current.hidden.includes(item.id))
                                .map((item) => item.id);
                            return {
                              ...current,
                              cardProperties: event.target.checked
                                ? [...currentFields, prop.id]
                                : currentFields.filter((id) => id !== prop.id),
                            };
                          })
                        }
                      />{' '}
                      {prop.name}
                    </label>
                  );
                })}
              </fieldset>
            </>
          )}
        </Popover>
      )}
      {panel?.kind === 'summary' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.summary')}
          className="db-panel"
        >
          {database.properties.map((prop) => {
            const numeric =
              isNumericPropertyType(prop.type) || prop.type === 'formula' || prop.fillMode === 'calculated';
            const operations: SummaryOperation[] = numeric
              ? ['sum', 'average', 'count', 'min', 'max']
              : ['count'];
            return (
              <label key={prop.id} className="field">
                <span>{prop.name}</span>
                <select
                  className="text-input small"
                  value={view.summaries?.[prop.id] ?? ''}
                  onChange={(event) =>
                    saveView((current) => {
                      const summaries = { ...current.summaries };
                      if (event.target.value) summaries[prop.id] = event.target.value as SummaryOperation;
                      else delete summaries[prop.id];
                      return { ...current, summaries };
                    })
                  }
                >
                  <option value="">{t('database.summaryNone')}</option>
                  {operations.map((operation) => (
                    <option key={operation} value={operation}>
                      {summaryLabel(operation)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </Popover>
      )}
      {panel?.kind === 'format' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.conditionalFormatting')}
          className="db-panel"
        >
          {(view.conditionalFormats ?? []).map((rule) => {
            const prop = database.properties.find((candidate) => candidate.id === rule.prop);
            const type = propType(database, rule.prop) ?? 'text';
            const value = ruleValueForInput(rule.value, prop, type);
            const needsValue = !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
            const editRule = (patch: Partial<ConditionalFormatRule>) =>
              saveView((current) => ({
                ...current,
                conditionalFormats: (current.conditionalFormats ?? []).map((candidate) =>
                  candidate.id === rule.id ? { ...candidate, ...patch } : candidate,
                ),
              }));
            return (
              <div key={rule.id} className="db-conditional-rule">
                    <select
                  className="text-input small"
                  aria-label={t('database.property')}
                  value={rule.prop}
                  onChange={(event) => {
                    const nextType = propType(database, event.target.value) ?? 'text';
                    editRule({
                      prop: event.target.value,
                      op: filterOpsFor(nextType === 'title' ? 'text' : nextType)[0]!,
                      value: null,
                    });
                  }}
                >
                  {names.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <select
                  className="text-input small"
                  aria-label={t('database.conditionScope')}
                  value={rule.scope}
                  onChange={(event) => editRule({ scope: event.target.value === 'cell' ? 'cell' : 'row' })}
                >
                  <option value="row">{t('database.entireRow')}</option>
                  <option value="cell">{t('database.matchingCell')}</option>
                </select>
                <select
                  className="text-input small"
                  aria-label={t('database.condition')}
                  value={rule.op}
                  onChange={(event) => editRule({ op: event.target.value as FilterOp, value: null })}
                >
                  {filterOpsFor(type === 'title' ? 'text' : type).map((op) => (
                    <option key={op} value={op}>
                      {filterLabel(op)}
                    </option>
                  ))}
                </select>
                {needsValue &&
                  (prop && (prop.type === 'select' || prop.type === 'multiSelect') ? (
                    <select
                      className="text-input small"
                      aria-label={t('database.value')}
                      value={String(rule.value ?? '')}
                      onChange={(event) => editRule({ value: event.target.value || null })}
                    >
                      <option value="">{t('database.choose')}</option>
                      {prop.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="text-input small"
                      aria-label={t('database.value')}
                      type={
                        prop && isNumericPropertyType(prop.type)
                          ? 'number'
                          : type === 'datetime' || type === 'createdTime' || type === 'lastEditedTime'
                            ? 'datetime-local'
                            : prop?.type === 'date' || prop?.type === 'time'
                              ? prop.type
                              : 'text'
                      }
                      step={prop && isNumericPropertyType(prop.type) ? 'any' : undefined}
                      value={value}
                      onChange={(event) =>
                        editRule({ value: ruleValueFromInput(event.target.value, rule.value, prop, type) })
                      }
                    />
                  ))}
                <select
                  className="text-input small"
                  aria-label={t('database.backgroundColor')}
                  value={rule.color}
                  onChange={(event) => editRule({ color: event.target.value as ColorName })}
                >
                  {COLORS.map((color) => (
                    <option key={color} value={color}>
                      {colorLabel(color)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.removeFilter')}
                  onClick={() =>
                    saveView((current) => ({
                      ...current,
                      conditionalFormats: (current.conditionalFormats ?? []).filter(
                        (candidate) => candidate.id !== rule.id,
                      ),
                    }))
                  }
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              saveView((current) => ({
                ...current,
                conditionalFormats: [
                  ...(current.conditionalFormats ?? []),
                  {
                    id: newId(),
                    prop: TITLE_PROP,
                    op: 'notEmpty',
                    value: null,
                    scope: 'row',
                    color: 'yellow',
                  },
                ],
              }))
            }
          >
            <Plus size={13} /> {t('database.addCondition')}
          </button>
        </Popover>
      )}
      {panel?.kind === 'properties' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => setPanel(null)}
          label={t('database.properties')}
          className="db-panel"
        >
          <ul className="db-prop-list">
            {orderedProperties(database, view).map((prop, index, ordered) => {
              const hidden = view.hidden.includes(prop.id);
              const wrap = view.wrap?.includes(prop.id) ?? false;
              const alignment = view.align?.[prop.id] ?? 'left';
              return (
                <li key={prop.id}>
                  <span className="db-prop-name">{prop.name}</span>
                  <span className="muted small">{propLabel(prop.type)}</span>
                  <div className="db-prop-order">
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('database.movePropUp', { name: prop.name })}
                      disabled={!editable || index === 0}
                      onClick={() =>
                        saveView((current) => {
                          const ids = orderedProperties(database, current).map((item) => item.id);
                          [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                          return { ...current, order: ids };
                        })
                      }
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('database.movePropDown', { name: prop.name })}
                      disabled={!editable || index === ordered.length - 1}
                      onClick={() =>
                        saveView((current) => {
                          const ids = orderedProperties(database, current).map((item) => item.id);
                          [ids[index], ids[index + 1]] = [ids[index + 1]!, ids[index]!];
                          return { ...current, order: ids };
                        })
                      }
                    >
                      <ArrowDown size={12} />
                    </button>
                  </div>
                  <label className="db-prop-wrap">
                    <input
                      type="checkbox"
                      checked={wrap}
                      disabled={!editable}
                      onChange={(event) =>
                        saveView((current) => ({
                          ...current,
                          wrap: event.target.checked
                            ? [...(current.wrap ?? []).filter((id) => id !== prop.id), prop.id]
                            : (current.wrap ?? []).filter((id) => id !== prop.id),
                        }))
                      }
                    />{' '}
                    {t('database.wrapText')}
                  </label>
                  <select
                    className="text-input small"
                    aria-label={t('database.alignment')}
                    value={alignment}
                    disabled={!editable}
                    onChange={(event) =>
                      saveView((current) => {
                        const align = { ...current.align };
                        if (event.target.value === 'left') delete align[prop.id];
                        else align[prop.id] = event.target.value as 'center' | 'right';
                        return { ...current, align };
                      })
                    }
                  >
                    <option value="left">{t('database.alignLeft')}</option>
                    <option value="center">{t('database.alignCenter')}</option>
                    <option value="right">{t('database.alignRight')}</option>
                  </select>
                  <button
                    type="button"
                    className="icon-button tiny"
                    aria-label={
                      hidden
                        ? t('database.showProp', { name: prop.name })
                        : t('database.hideProp', { name: prop.name })
                    }
                    disabled={!editable}
                    onClick={() =>
                      saveView((current) => ({
                        ...current,
                        hidden: hidden
                          ? current.hidden.filter((id) => id !== prop.id)
                          : [...current.hidden, prop.id],
                      }))
                    }
                  >
                    {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                </li>
              );
            })}
          </ul>
          {editable && <NewProperty dbId={dbId} database={database} />}
          {editable && unclaimed.length > 0 && (
            <>
              <p className="db-panel-heading">{t('database.inYourPages')}</p>
              <ul className="db-prop-list">
                {unclaimed.map((key) => (
                  <li key={key}>
                    <span className="db-prop-name">{key}</span>
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={t('database.addColumnAria', { key })}
                      title={t('database.addAsAColumn')}
                      onClick={() => addColumnsFromPages(dbId, [key])}
                    >
                      <Plus size={13} />
                    </button>
                  </li>
                ))}
              </ul>
              {unclaimed.length > 1 && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => addColumnsFromPages(dbId, unclaimed)}
                >
                  {t('database.addAllAsColumns')}
                </button>
              )}
            </>
          )}
        </Popover>
      )}
    </div>
  );
}

// rename a property, change its type or options, or delete it
interface ViewProps {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  props: PropDef[];
  editable: boolean;
}

function RowTitle({ row, editable, autoFocus }: { row: PageMeta; editable: boolean; autoFocus?: boolean }) {
  return (
    <div className="db-title">
      <span className="tree-icon">
        <PageIcon page={row} />
      </span>
      <DraftInput
        type="text"
        label={t('database.name')}
        className="db-title-input"
        value={row.title}
        placeholder={t('page.untitled')}
        editable={editable}
        onCommit={(title) => run({ type: 'page.rename', id: row.id, title, now: Date.now() })}
      />
      {autoFocus && <FocusLast />}
      <button
        type="button"
        className="icon-button tiny db-open"
        aria-label={t('database.openTitle', { title: displayTitle(row) })}
        title={t('common.open')}
        onClick={() => openPage(row.id)}
      >
        <Maximize2 size={13} />
      </button>
    </div>
  );
}

// moves focus into the title of a row just added to a table
function FocusLast() {
  useEffect(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('.db-table .db-title-input');
    inputs[inputs.length - 1]?.focus();
  }, []);
  return null;
}

const TITLE_WIDTH = 260;
const COLUMN_WIDTH = 180;

// drag a column's right edge to size it, a double click goes back to the usual width
function ColumnResizer({
  width,
  onResize,
  onDone,
  onReset,
}: {
  width: number;
  onResize: (width: number) => void;
  onDone: (width: number) => void;
  onReset: () => void;
}) {
  return (
    <span
      className="db-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('database.dragToResize')}
      onDoubleClick={onReset}
      onPointerDown={(event) => {
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture(event.pointerId);
        const start = event.clientX;
        let next = width;
        const move = (moved: PointerEvent) => {
          next = Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + moved.clientX - start));
          onResize(next);
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          onDone(next);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      }}
    />
  );
}

function ColumnDescription({ description }: { description: string }) {
  const descriptionId = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const visible = hovered || focused;

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!visible || !trigger || !tooltip) return;

    let cancelled = false;
    const place = () => {
      void computePosition(trigger, tooltip, {
        placement: 'top-start',
        strategy: 'fixed',
        middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
      }).then(({ x, y }) => {
        if (cancelled || !tooltip.isConnected) return;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
        tooltip.style.visibility = 'visible';
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(tooltip);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [visible]);

  return (
    <>
      <span
        ref={triggerRef}
        className="db-header-info"
        tabIndex={0}
        role="img"
        aria-label={t('database.description')}
        aria-describedby={descriptionId}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <Info size={14} aria-hidden="true" />
      </span>
      <span id={descriptionId} className="db-header-description-text" role="tooltip">
        {description}
      </span>
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tooltipRef}
            className="db-header-tooltip"
            role="tooltip"
            aria-hidden="true"
            style={{ visibility: 'hidden' }}
          >
            {description}
          </span>,
          document.body,
        )}
    </>
  );
}

function InsertColumnPopover({
  dbId,
  database,
  view,
  anchor,
  anchorPropId,
  position,
  onClose,
}: {
  dbId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  anchor: HTMLElement;
  anchorPropId: string;
  position: ColumnInsertPosition;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PropType>('text');
  const saveView = useViewUpdater(dbId, view.id);
  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    if (
      reservedPropertyName(clean) ||
      database.properties.some((prop) => prop.name.toLowerCase() === clean.toLowerCase())
    ) {
      toast(t('toasts.propNameDuplicate', { name: clean }), { tone: 'error' });
      return;
    }

    const property: PropDef = {
      id: newId(),
      name: clean,
      type,
      options: [],
      ...(type === 'button'
        ? { action: { label: clean, icon: 'play' as const, color: 'blue' as const, steps: [] } }
        : {}),
      ...(type === 'image' || type === 'file' ? { media: { multiple: false } } : {}),
    };
    const insertion = insertPropertyNear(database, view, property, anchorPropId, position);
    if (!insertion) return;
    const added = updateDatabase(dbId, (current) =>
      insertPropertyNear(current, view, property, anchorPropId, position)?.database ?? current,
    );
    if (!added) return;
    saveView((current) => ({ ...current, order: insertion.view.order }));
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label={t('database.newProperty')} className="db-panel">
      <form
        className="db-rule"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <input
          className="text-input small"
          data-autofocus
          placeholder={t('database.newProperty')}
          aria-label={t('page.newPropertyNameAria')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="text-input small"
          aria-label={t('database.type')}
          value={type}
          onChange={(event) => setType(event.target.value as PropType)}
        >
          {PROP_TYPES.map((item) => (
            <option key={item} value={item}>
              {propLabel(item)}
            </option>
          ))}
        </select>
        <button type="submit" className="button small" disabled={!name.trim()}>
          {t('common.add')}
        </button>
      </form>
    </Popover>
  );
}

function TableView({ dbId, database, view, rows, props, editable, onRequestFilter }: ViewProps & {
  onRequestFilter: (propId: string) => void;
}) {
  const saveView = useViewUpdater(dbId, view.id);
  const state = useWorkspace();
  const [header, setHeader] = useState<{ prop: PropDef; anchor: HTMLElement } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ prop: PropDef; anchor: HTMLElement } | null>(null);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [inserting, setInserting] = useState<{
    prop: PropDef;
    anchor: HTMLElement;
    position: ColumnInsertPosition;
  } | null>(null);
  const [focusNew, setFocusNew] = useState<string | null>(null);
  // the width being dragged, saved to the view once the drag ends
  const [dragging, setDragging] = useState<{ key: string; width: number } | null>(null);
  const widthOf = (key: string) =>
    dragging?.key === key
      ? dragging.width
      : (view.widths?.[key] ?? (key === TITLE_PROP ? TITLE_WIDTH : COLUMN_WIDTH));
  const saveWidth = (key: string, width: number | null) => {
    setDragging(null);
    saveView((current) => {
      const widths = { ...current.widths };
      if (width === null) delete widths[key];
      else widths[key] = width;
      return { ...current, widths };
    });
  };
  const resizer = (key: string) =>
    editable && (
      <ColumnResizer
        width={widthOf(key)}
        onResize={(width) => setDragging({ key, width })}
        onDone={(width) => saveWidth(key, width)}
        onReset={() => saveWidth(key, null)}
      />
    );
  const total =
    widthOf(TITLE_PROP) + props.reduce((sum, prop) => sum + widthOf(prop.id), 0) + (editable ? 36 : 0);
  const selectedSort = columnMenu ? view.sorts.find((item) => item.prop === columnMenu.prop.id) : undefined;
  const openColumnMenu = (prop: PropDef, anchor: HTMLElement) => {
    setHeader(null);
    setInserting(null);
    setColumnMenu({ prop, anchor });
  };
  const duplicateColumn = (propId: string, includeValues: boolean) => {
    const plan = planColumnDuplicate(state, dbId, propId, newId(), includeValues, Date.now(), t('database.copySuffix'));
    if (!plan) {
      toast(t('database.duplicateColumnUnavailable'), { tone: 'error' });
      return;
    }
    if (!runAll(plan.commands).ok) return;
    const snapshot = snapshotColumnDuplicate(getState(), dbId, plan.property.id);
    if (!snapshot) return;
    toast(t('database.columnDuplicated'), {
      durationMs: 12_000,
      action: {
        label: t('toasts.undo'),
        run: () => {
          const undo = planColumnDuplicateUndo(getState(), dbId, plan.property.id, snapshot, Date.now());
          if (!undo) {
            toast(t('database.duplicateColumnUndoUnavailable'), { tone: 'error' });
            return;
          }
          runAll(undo);
        },
      },
    });
  };
  return (
    <div className="db-table-wrap">
      <table className={`db-table${editable ? ' is-filled' : ''}`} style={{ width: total }}>
        <colgroup>
          <col style={{ width: widthOf(TITLE_PROP) }} />
          {props.map((prop) => (
            <col key={prop.id} style={{ width: widthOf(prop.id) }} />
          ))}
          {/* the add column takes whatever room is left, so the others keep the width they were given */}
          {editable && <col />}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="db-col-title">
              {t('database.name')}
              {resizer(TITLE_PROP)}
            </th>
            {props.map((prop) => {
              const description = prop.description?.trim() ? prop.description : null;
              return (
                <th key={prop.id} scope="col">
                  <div className="db-header-row">
                    <button
                      type="button"
                      className="db-header"
                      disabled={!editable}
                      aria-haspopup={editable ? 'menu' : undefined}
                      aria-expanded={columnMenu?.prop.id === prop.id}
                      aria-keyshortcuts="Shift+F10 ContextMenu"
                      title={editable ? t('database.columnMenuHint') : undefined}
                      onClick={(event) => {
                        setColumnMenu(null);
                        setInserting(null);
                        setHeader({ prop, anchor: event.currentTarget });
                      }}
                      onContextMenu={(event) => {
                        if (!editable) return;
                        event.preventDefault();
                        openColumnMenu(prop, event.currentTarget);
                      }}
                      onKeyDown={(event) => {
                        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
                          event.preventDefault();
                          openColumnMenu(prop, event.currentTarget);
                        }
                      }}
                    >
                      <span className="db-header-name">{prop.name}</span>
                    </button>
                    {description && (
                      <span className="db-header-info-wrap">
                        <ColumnDescription description={description} />
                      </span>
                    )}
                  </div>
                  {resizer(prop.id)}
                </th>
              );
            })}
            {editable && (
              <th className="db-col-add">
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('page.addAProperty')}
                  onClick={(event) => setAdding(event.currentTarget)}
                >
                  <Plus size={13} />
                </button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowRule = conditionalFormatForRow(row, view.conditionalFormats, database, state);
            const rowStyle = rowRule ? conditionalColorStyle(rowRule.color) : undefined;
            const titleRule = conditionalFormatForCell(
              row,
              TITLE_PROP,
              view.conditionalFormats,
              database,
              state,
            );
            return (
              <tr key={row.id} style={rowStyle}>
                <td
                  className="db-col-title"
                  style={{ ...rowStyle, ...(titleRule ? conditionalColorStyle(titleRule.color) : {}) }}
                >
                  <RowTitle row={row} editable={editable} autoFocus={focusNew === row.id} />
                </td>
                {props.map((prop) => {
                  const cellRule = conditionalFormatForCell(
                    row,
                    prop.id,
                    view.conditionalFormats,
                    database,
                    state,
                  );
                  return (
                    <td
                      key={prop.id}
                      style={{
                        ...rowStyle,
                        ...(cellRule ? conditionalColorStyle(cellRule.color) : {}),
                        textAlign: view.align?.[prop.id] ?? 'left',
                        whiteSpace: view.wrap?.includes(prop.id) ? 'normal' : 'nowrap',
                      }}
                    >
                      <PropertyInput dbId={dbId} prop={prop} row={row} editable={editable} />
                    </td>
                  );
                })}
                {editable && <td style={rowStyle} />}
              </tr>
            );
          })}
        </tbody>
        {props.some((prop) => view.summaries?.[prop.id]) && (
          <tfoot>
            <tr>
              <th scope="row" className="db-col-title">
                {t('database.summary')}
              </th>
              {props.map((prop) => {
                const operation = view.summaries?.[prop.id];
                if (!operation) return <td key={prop.id} />;
                const summary = summarizeProperty(rows, prop, operation, database, state);
                return (
                  <td key={prop.id} title={summary.error ?? undefined}>
                    {summary.error
                      ? t('database.summaryFormulaError', { error: summary.error })
                      : summary.value === null
                        ? ''
                        : operation === 'count'
                          ? String(summary.value)
                          : formatDisplayValue(prop, summary.value, getLocale())}
                  </td>
                );
              })}
              {editable && <td />}
            </tr>
          </tfoot>
        )}
      </table>
      {editable && (
        <button
          type="button"
          className="db-new-row"
          onClick={() => {
            const id = createRow(dbId);
            if (id) setFocusNew(id);
          }}
        >
          <Plus size={14} /> {t('database.new')}
        </button>
      )}
      {header && (
        <PropertySettings
          dbId={dbId}
          database={database}
          prop={header.prop}
          view={view}
          anchor={header.anchor}
          onClose={() => setHeader(null)}
        />
      )}
      {columnMenu && (
        <Menu
          anchor={columnMenu.anchor}
          label={t('database.columnMenuAria', { name: columnMenu.prop.name })}
          onClose={() => setColumnMenu(null)}
          entries={[
            { heading: columnMenu.prop.name },
            {
              label: t('database.editColumnSettings'),
              icon: Settings2,
              onSelect: () => setHeader({ prop: columnMenu.prop, anchor: columnMenu.anchor }),
            },
            { separator: true },
            {
              label: t('database.sortAscending'),
              icon: ArrowUp,
              checked: selectedSort?.dir === 'asc',
              onSelect: () =>
                saveView((current) => ({
                  ...current,
                  sorts: [
                    { prop: columnMenu.prop.id, dir: 'asc' },
                    ...current.sorts.filter((item) => item.prop !== columnMenu.prop.id),
                  ],
                })),
            },
            {
              label: t('database.sortDescending'),
              icon: ArrowDown,
              checked: selectedSort?.dir === 'desc',
              onSelect: () =>
                saveView((current) => ({
                  ...current,
                  sorts: [
                    { prop: columnMenu.prop.id, dir: 'desc' },
                    ...current.sorts.filter((item) => item.prop !== columnMenu.prop.id),
                  ],
                })),
            },
            ...(selectedSort
              ? [
                  {
                    label: t('database.removeSort'),
                    icon: X,
                    onSelect: () =>
                      saveView((current) => ({
                        ...current,
                        sorts: current.sorts.filter((item) => item.prop !== columnMenu.prop.id),
                      })),
                  },
                ]
              : []),
            { separator: true },
            {
              label: t('database.filterColumn'),
              icon: Filter,
              onSelect: () => onRequestFilter(columnMenu.prop.id),
            },
            { separator: true },
            {
              label: t('database.insertColumnBefore'),
              icon: Plus,
              onSelect: () =>
                setInserting({ prop: columnMenu.prop, anchor: columnMenu.anchor, position: 'before' }),
            },
            {
              label: t('database.insertColumnAfter'),
              icon: Plus,
              onSelect: () =>
                setInserting({ prop: columnMenu.prop, anchor: columnMenu.anchor, position: 'after' }),
            },
            { separator: true },
            {
              label: t('database.duplicateColumnEmpty'),
              icon: Copy,
              onSelect: () => duplicateColumn(columnMenu.prop.id, false),
            },
            {
              label: t('database.duplicateColumnValues'),
              icon: Copy,
              onSelect: () => duplicateColumn(columnMenu.prop.id, true),
            },
          ]}
        />
      )}
      {adding && (
        <Popover
          anchor={adding}
          onClose={() => setAdding(null)}
          label={t('database.newProperty')}
          className="db-panel"
        >
          <NewProperty dbId={dbId} database={database} onDone={() => setAdding(null)} />
        </Popover>
      )}
      {inserting && (
        <InsertColumnPopover
          dbId={dbId}
          database={database}
          view={view}
          anchor={inserting.anchor}
          anchorPropId={inserting.prop.id}
          position={inserting.position}
          onClose={() => setInserting(null)}
        />
      )}
    </div>
  );
}

function Card({
  row,
  props,
  database,
  cover,
  imageProp,
  view,
}: {
  row: PageMeta;
  props: PropDef[];
  database: DatabaseDef;
  cover?: boolean;
  imageProp?: PropDef | null;
  view: ViewDef;
}) {
  const state = useWorkspace();
  const [image, setImage] = useState<string | null>(null);
  const firstImage = useMemo(() => {
    if (!cover || imageProp) return null;
    const doc = state.docs[row.id];
    const node = doc?.content?.find(
      (child) => child.type === 'image' && typeof child.attrs?.fileId === 'string',
    );
    return node ? String(node.attrs!.fileId) : null;
  }, [cover, imageProp, state.docs, row.id]);
  const progress = useMemo(() => taskProgress(state.docs[row.id]), [state.docs, row.id]);
  const rowRule = conditionalFormatForRow(row, view.conditionalFormats, database, state);
  const rowStyle = rowRule ? conditionalColorStyle(rowRule.color) : undefined;
  useEffect(() => {
    let live = true;
    if (firstImage) void fileUrl(firstImage).then((url) => live && setImage(url));
    return () => {
      live = false;
    };
  }, [firstImage]);
  return (
    <button type="button" className="db-card" style={rowStyle} onClick={() => openPage(row.id)}>
      {(cover || imageProp) && (
        <span className="db-cover">
          {imageProp ? (
            <PropertyDisplay prop={imageProp} value={valueOf(row, imageProp.id, database, state)} />
          ) : image ? (
            <img src={image} alt="" />
          ) : (
            <span className="db-cover-empty" />
          )}
        </span>
      )}
      <span className="db-card-title">
        {row.icon && <PageGlyph icon={row.icon} className="db-card-icon" />}
        {displayTitle(row)}
      </span>
      <span className="db-card-props">
        {props.map((prop) => {
          const cellRule = conditionalFormatForCell(row, prop.id, view.conditionalFormats, database, state);
          return (
            <span key={prop.id} style={cellRule ? conditionalColorStyle(cellRule.color) : undefined}>
              <PropertyDisplay prop={prop} value={valueOf(row, prop.id, database, state)} />
            </span>
          );
        })}
      </span>
      {progress.total > 0 && (
        <span
          className="db-progress"
          title={t('database.tasksDone', { done: progress.done, total: progress.total })}
        >
          <span className="db-progress-bar">
            <span style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </span>
          <span className="db-progress-label">
            {progress.done}/{progress.total}
          </span>
        </span>
      )}
    </button>
  );
}

// how many of the checklist items in a page are ticked
function taskProgress(doc: DocNode | undefined): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const visit = (node: DocNode) => {
    if (node.type === 'taskItem') {
      total++;
      if (node.attrs?.checked === true) done++;
    }
    for (const child of node.content ?? []) visit(child);
  };
  if (doc) visit(doc);
  return { done, total };
}

const DRAG = 'application/x-morrow-row';

function BoardView({ dbId, database, view, rows, editable }: Omit<ViewProps, 'props'>) {
  const state = useWorkspace();
  const prop = database.properties.find((candidate) => candidate.id === view.groupBy);
  // an empty column for rows without a value only adds noise
  const groups = groupRows(rows, view.groupBy, database, state).filter(
    (group) => group.key !== null || group.rows.length > 0,
  );
  const [over, setOver] = useState<string | null>(null);
  if (!prop) return <p className="muted db-hint">{t('database.boardHint')}</p>;
  const canEditGroup = editable && prop.type !== 'formula' && prop.fillMode !== 'calculated';
  const cardProps = view.cardProperties
    ? database.properties.filter((item) => view.cardProperties!.includes(item.id))
    : database.properties.filter((item) => !view.hidden.includes(item.id));
  const imageProp = view.cardImageProp
    ? (database.properties.find((item) => item.id === view.cardImageProp) ?? null)
    : null;
  const shown = cardProps.filter((item) => item.id !== prop.id && item.id !== imageProp?.id);
  const valueFor = (key: string | null): PropValue => {
    if (prop.type === 'checkbox') return key === 'true';
    if (key === null) return null;
    return prop.type === 'multiSelect' ? [key] : key;
  };
  return (
    <div className="db-board">
      {groups.map((group) => {
        const key = group.key ?? '__none';
        return (
          <section
            key={key}
            className={`db-column color-${group.color ?? 'gray'}${over === key ? ' is-over' : ''}`}
            aria-label={group.label}
            onDragOver={(event) => {
              if (!canEditGroup || !event.dataTransfer.types.includes(DRAG)) return;
              event.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver((current) => (current === key ? null : current))}
            onDrop={(event) => {
              setOver(null);
              const id = event.dataTransfer.getData(DRAG);
              if (id && canEditGroup) setValue(id, prop.id, valueFor(group.key));
            }}
          >
            <header className="db-column-head">
              <span className="db-column-dot" aria-hidden="true" />
              <Chip option={{ name: group.label, color: group.color }} />
              <span className="muted small">{group.rows.length}</span>
            </header>
            {group.rows.map((row) => (
              <div
                key={row.id}
                draggable={canEditGroup}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG, row.id);
                  event.dataTransfer.effectAllowed = 'move';
                }}
              >
                <Card
                  row={row}
                  props={shown}
                  database={database}
                  view={view}
                  cover={Boolean(imageProp)}
                  imageProp={imageProp}
                />
              </div>
            ))}
            {editable && (
              <button
                type="button"
                className="db-new-row"
                onClick={() => newRowAndOpen(dbId, canEditGroup ? { [prop.id]: valueFor(group.key) } : {})}
              >
                <Plus size={13} /> {t('database.new')}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CalendarView({ dbId, database, view, rows, editable }: Omit<ViewProps, 'props'>) {
  const state = useWorkspace();
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [over, setOver] = useState<string | null>(null);
  const prop = database.properties.find((candidate) => candidate.id === view.dateProp);
  if (!prop) return <p className="muted db-hint">{t('database.calendarHint')}</p>;
  const canEditDate = editable && prop.type !== 'formula' && prop.fillMode !== 'calculated';
  // weeks start on monday
  const start = new Date(month);
  start.setDate(1 - ((month.getDay() + 6) % 7));
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
  );
  const byDay = new Map<string, PageMeta[]>();
  for (const row of rows) {
    const key = calendarDayForRow(row, prop, database, state);
    if (key) byDay.set(key, [...(byDay.get(key) ?? []), row]);
  }
  const today = dateKey(new Date());
  const shift = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  return (
    <div className="db-calendar">
      <header className="db-calendar-head">
        <h3>{month.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' })}</h3>
        <button
          type="button"
          className="icon-button small"
          aria-label={t('database.previousMonth')}
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >
          {t('sidebar.today')}
        </button>
        <button
          type="button"
          className="icon-button small"
          aria-label={t('database.nextMonth')}
          onClick={() => shift(1)}
        >
          <ChevronRight size={15} />
        </button>
      </header>
      <div className="db-calendar-grid" role="grid">
        {days.slice(0, 7).map((day) => (
          <div key={day.toISOString()} className="db-weekday" role="columnheader">
            {day.toLocaleDateString(dateLocale(), { weekday: 'short' })}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKey(day);
          const inMonth = day.getMonth() === month.getMonth();
          return (
            <div
              key={key}
              role="gridcell"
              className={`db-day${inMonth ? '' : ' is-outside'}${key === today ? ' is-today' : ''}${over === key ? ' is-over' : ''}`}
              onDragOver={(event) => {
                if (!canEditDate || !event.dataTransfer.types.includes(DRAG)) return;
                event.preventDefault();
                setOver(key);
              }}
              onDragLeave={() => setOver((current) => (current === key ? null : current))}
              onDrop={(event) => {
                setOver(null);
                const id = event.dataTransfer.getData(DRAG);
                if (id && canEditDate) setValue(id, prop.id, key);
              }}
            >
              <span className="db-day-number">{day.getDate()}</span>
              {(byDay.get(key) ?? []).map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="db-event"
                  draggable={editable}
                  onDragStart={(event) => event.dataTransfer.setData(DRAG, row.id)}
                  onClick={() => openPage(row.id)}
                >
                  {displayTitle(row)}
                </button>
              ))}
              {editable && (
                <button
                  type="button"
                  className="db-day-add"
                  aria-label={t('database.newRowOn', { date: day.toLocaleDateString(dateLocale()) })}
                  onClick={() => newRowAndOpen(dbId, canEditDate ? { [prop.id]: key } : {})}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ListView({ rows, props, database }: { rows: PageMeta[]; props: PropDef[]; database: DatabaseDef }) {
  const state = useWorkspace();
  return (
    <ul className="link-list db-list">
      {rows.map((row) => (
        <li key={row.id}>
          <button type="button" className="link-row" onClick={() => openPage(row.id)}>
            <span className="tree-icon">
              <PageIcon page={row} />
            </span>
            <span className="link-row-title">{displayTitle(row)}</span>
            <span className="db-card-props">
              {props.map((prop) => (
                <PropertyDisplay key={prop.id} prop={prop} value={valueOf(row, prop.id, database, state)} />
              ))}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function GalleryView({ rows, database, view }: { rows: PageMeta[]; database: DatabaseDef; view: ViewDef }) {
  const state = useWorkspace();
  const cardProps = view.cardProperties
    ? database.properties.filter((prop) => view.cardProperties!.includes(prop.id))
    : database.properties.filter((prop) => !view.hidden.includes(prop.id));
  const imageProp = view.cardImageProp
    ? (database.properties.find((prop) => prop.id === view.cardImageProp) ?? null)
    : null;
  const shown = cardProps.filter((prop) => prop.id !== imageProp?.id);
  const groups = view.groupBy
    ? groupRows(rows, view.groupBy, database, state).filter(
        (group) => group.key !== null || group.rows.length > 0,
      )
    : [{ key: null, label: '', color: 'gray' as const, rows }];
  const cards = (items: PageMeta[]) =>
    items.map((row) => (
      <Card
        key={row.id}
        row={row}
        props={shown}
        database={database}
        view={view}
        cover={view.cardImageProp === undefined}
        imageProp={imageProp}
      />
    ));
  return view.groupBy ? (
    <div className="db-gallery-grouped">
      {groups.map((group) => (
        <section key={group.key ?? '__none'} className="db-gallery-group">
          <header className={`db-column-head color-${group.color}`}>
            <Chip option={{ name: group.label, color: group.color }} />
            <span className="muted small">{group.rows.length}</span>
          </header>
          <div className="db-gallery">{cards(group.rows)}</div>
        </section>
      ))}
    </div>
  ) : (
    <div className="db-gallery">{cards(rows)}</div>
  );
}
