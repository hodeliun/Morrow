import {
  ArrowDownUp,
  ArrowDown,
  Link as LinkIcon,
  SlidersHorizontal,
  ArrowUp,
  Calculator,
  Calendar,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Columns3,
  Copy,
  Eye,
  EyeOff,
  Filter,
  GalleryVerticalEnd,
  GripVertical,
  Info,
  LayoutList,
  Maximize2,
  MoreHorizontal,
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
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { dateKey } from '../../../core/daily';
import { parseFormula } from '../../../core/formula';
import {
  planColumnDuplicate,
  planColumnDuplicateUndo,
  snapshotColumnDuplicate,
} from '../../../core/columnDuplicate';
import {
  bindPageFormulaReferences,
  conditionalFormatRuleConfigurationIssue,
  filterOpsFor,
  calendarDayForRow,
  resolveConditionalFormatForCell,
  resolveConditionalFormatForRow,
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
import type { ConditionalFormatDiagnostic, ResolvedConditionalFormatStyle } from '../../../core/database';
import { BACKGROUND_HEX, TEXT_HEX, validHexColor, COLORS, displayTitle, VIEW_TYPES } from '../../../core/model';
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
  ColorValue,
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
import {
  readClipboardText,
  readGridClipboard,
  writeClipboardText,
  writeGridClipboard,
} from '../../platform/clipboard';
import { newId } from '../../platform/files';
import { openPage } from '../../router';
import { getSession, getState, run, runAll, useWorkspace } from '../../workspace';
import { Menu } from '../Menu';
import { Popover } from '../Popover';
import { Dialog } from '../primitives';
import { PageGlyph } from '../Emoji';
import { PageIcon } from '../Sidebar';
import { addColumnsFromPages, createRow, setValue, updateDatabase, updateView } from './data';
import { Chip, DraftInput, NewProperty, PropertyDisplay, PropertyInput } from './PropertyValue';
import { cellEditStartKey, cellPickerStartProps } from './cellEditing';
import { PropertySettings } from './PropertySettings';
import { PropertyGlyph, PropertyTypeSelect } from './PropertyTypeSelect';
import { presentFormulaDiagnostic } from './formulaEditorModel';
import type { FormulaDiagnosticPresentation } from './formulaEditorModel';
import { TableActionRecoveryNotice } from './TableActionCell';
import { dateLocale, getLocale, t, tp } from '../../i18n';
import { colorLabel, filterLabel, propLabel, viewLabel, viewName } from '../../i18n/labels';
import { durationUnitFactor, isNumericPropertyType, scalarValueError } from '../../../core/typedValues';
import { linkedViewReferences } from '../../../core/linkedViews';
import { namedControlIdentifier } from '../../../core/controls';
import { childrenOf, descendantsOf } from '../../../core/tree';
import { ViewChangeContext } from './viewContext';
import { insertPropertyNear } from './columnActions';
import {
  isColumnReadOnly,
  planGridClear,
  planGridFill,
  planGridPaste,
  resolveVisibleRange,
  revalidateActiveCell,
  serializeGridClipboard,
  parseGridClipboard,
  validateGridClipboardEnvelope,
} from '../../../core/gridOperations';
import type {
  GridCoord,
  GridRange,
  GridClipboardPayload,
  FillModeChoice,
  GridOperationPlan,
} from '../../../core/gridOperations';
import type { ColumnInsertPosition } from './columnActions';
import type { Command } from '../../../core/commands';
import { reservedPropertyName } from '../../../core/vault/pageFile';
import { confirmAction, toast } from '../../ui';
import {
  asTableActionPlan,
  planDuplicateRows,
  planInsertRow,
  planMoveRows,
  planPasteRows,
  planReorderRows,
  planTrashRows,
  previewRowMappings,
  PRESERVE_ROW_PROPERTY,
  suggestRowPropertyMappings,
} from '../../../core/rowOperations';
import type { RowOperationPlan, RowPropertyMapping } from '../../../core/rowOperations';
import {
  createRowClipboardPayload,
  parseRowClipboardText,
  ROW_CLIPBOARD_PREFIX,
  serializeRowClipboard,
} from '../../../core/rowClipboard';
import type { RowClipboardPayload } from '../../../core/rowClipboard';
import { executeTableAction } from '../../../storage/tableActions';

const nowTimestamp = (): number => Date.now();

const ROW_CONTROLS_WIDTH = 68;
const ROW_CLIPBOARD_VERSION_MARKER = ROW_CLIPBOARD_PREFIX.slice(0, -1);

export function withoutConditionalFormatRule(view: ViewDef, ruleId: string): ViewDef {
  return {
    ...view,
    conditionalFormats: (view.conditionalFormats ?? []).filter((rule) => rule.id !== ruleId),
  };
}

interface RowMappingDialogState {
  mode: 'copy' | 'move';
  payload: RowClipboardPayload;
  sourceDatabaseId: PageId;
  rowIds: PageId[];
  destinationDatabaseId: PageId;
  afterRowId: PageId | null;
  mappings: RowPropertyMapping;
}

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
    median: 'database.summaryMedian',
    min: 'database.summaryMinimum',
    max: 'database.summaryMaximum',
    range: 'database.summaryRange',
    count: 'database.summaryCountAll',
    countValues: 'database.summaryCountValues',
    countUnique: 'database.summaryCountUnique',
    countEmpty: 'database.summaryCountEmpty',
    countNotEmpty: 'database.summaryCountNotEmpty',
    percentEmpty: 'database.summaryPercentEmpty',
    percentNotEmpty: 'database.summaryPercentNotEmpty',
    checked: 'database.summaryChecked',
    unchecked: 'database.summaryUnchecked',
    percentChecked: 'database.summaryPercentChecked',
  };
  return t(keys[operation]);
}

function operationsForProp(prop: PropDef | undefined): SummaryOperation[] {
  if (!prop) {
    return ['count', 'countValues', 'countUnique', 'countEmpty', 'percentEmpty', 'percentNotEmpty'];
  }
  if (prop.type === 'checkbox') {
    return ['checked', 'unchecked', 'percentChecked', 'count', 'countEmpty', 'percentEmpty'];
  }
  if (
    prop.type === 'date' ||
    prop.type === 'datetime' ||
    prop.type === 'createdTime' ||
    prop.type === 'lastEditedTime'
  ) {
    return [
      'min',
      'max',
      'range',
      'count',
      'countValues',
      'countUnique',
      'countEmpty',
      'percentEmpty',
      'percentNotEmpty',
    ];
  }
  if (isNumericPropertyType(prop.type) || prop.type === 'formula' || prop.fillMode === 'calculated') {
    return [
      'sum',
      'average',
      'median',
      'min',
      'max',
      'range',
      'count',
      'countValues',
      'countUnique',
      'countEmpty',
      'percentEmpty',
      'percentNotEmpty',
    ];
  }
  return [
    'count',
    'countValues',
    'countUnique',
    'countEmpty',
    'countNotEmpty',
    'percentEmpty',
    'percentNotEmpty',
  ];
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

function contrastText(color: ColorValue): string {
  const hex = validHexColor(color) ? color : (BACKGROUND_HEX[color as ColorName] ?? '#f3f4f6');
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255) ?? [1, 1, 1];
  const weights = [0.2126, 0.7152, 0.0722];
  const luminance = channels.reduce((total, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return total + linear * weights[index]!;
  }, 0);
  return luminance > 0.45 ? '#202124' : '#ffffff';
}

function conditionalColorStyle(color: ColorValue): CSSProperties {
  const foreground = contrastText(color);
  const bg = validHexColor(color) ? color : (BACKGROUND_HEX[color as ColorName] ?? color);
  return {
    backgroundColor: bg,
    color: foreground,
    '--text': foreground,
    '--text-muted': foreground,
    '--text-faint': foreground,
  } as CSSProperties;
}

function conditionalFormatStyle(style: ResolvedConditionalFormatStyle): CSSProperties {
  const result: CSSProperties = {};
  if (style.backgroundColor !== undefined) Object.assign(result, conditionalColorStyle(style.backgroundColor));
  if (style.textColor !== undefined) {
    const foreground = validHexColor(style.textColor) ?? TEXT_HEX[style.textColor as ColorName] ?? style.textColor;
    Object.assign(result, {
      color: foreground,
      '--text': foreground,
      '--text-muted': foreground,
      '--text-faint': foreground,
    });
  }
  if (style.bold !== undefined) result.fontWeight = style.bold ? 700 : 400;
  if (style.italic !== undefined) result.fontStyle = style.italic ? 'italic' : 'normal';
  return result;
}

function localizedFormulaDiagnostic(error: string): FormulaDiagnosticPresentation {
  return presentFormulaDiagnostic(error, {
    memberAfterDot: (token) => t('formulaUx.memberAfterDot', { token }),
    unexpectedToken: (token) => t('formulaUx.unexpectedToken', { token }),
    invalidSummary: t('formulaUx.invalidSummary'),
  });
}

function conditionalDiagnosticText(diagnostic: ConditionalFormatDiagnostic): string {
  const params = diagnostic.params ?? {};
  const property = params.property ?? '';
  switch (diagnostic.code) {
    case 'propertyUnavailable':
      return t('database.conditionalRulePropertyUnavailable', { property });
    case 'operatorUnsupported':
      return t('database.conditionalRuleOperatorUnsupported', {
        operator: filterLabel((params.operator ?? 'is') as FilterOp),
        property,
      });
    case 'controlStateUnavailable':
    case 'controlUnavailable':
      return t('database.conditionalRuleControlUnavailable');
    case 'calculatedStateUnavailable':
    case 'formulaStateUnavailable':
      return t('database.conditionalRuleContextUnavailable');
    case 'finiteNumberRequired':
      return t('database.conditionalRuleNumberRequired', { property });
    case 'formulaRequired':
      return t('database.conditionalRuleFormulaRequired');
    case 'formulaEvaluationFailed':
      return localizedFormulaDiagnostic(params.detail ?? '').primary;
    case 'formulaMustBeBoolean':
      return t('database.formulaMustReturnBoolean');
    case 'unsupportedRule':
      return t('database.conditionalRuleUnsupported', {
        index: String((diagnostic.index ?? 0) + 1),
      });
    default:
      return t('database.conditionalRuleValueInvalid', { property });
  }
}

function conditionalDiagnosticTechnicalDetail(diagnostic: ConditionalFormatDiagnostic): string | null {
  return diagnostic.code === 'formulaEvaluationFailed'
    ? localizedFormulaDiagnostic(diagnostic.params?.detail ?? '').technicalDetail
    : null;
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
  canEditNow,
  hostPageId,
  embeddedView,
  onEmbeddedViewChange,
}: {
  page: PageMeta;
  editable: boolean;
  canEditNow?: () => boolean;
  hostPageId?: PageId;
  embeddedView?: ViewDef;
  onEmbeddedViewChange?: (change: (view: ViewDef) => ViewDef) => void;
}) {
  const state = useWorkspace();
  const database = useMemo(() => page.database ?? { properties: [], views: [] }, [page.database]);
  const canEdit = editable && !database.unsupportedProperties?.length;
  const [viewId, setViewId] = useState<string | null>(() => readViewChoice(page.id));
  const tabsViewportRef = useRef<HTMLDivElement>(null);
  const [tabScrollHints, setTabScrollHints] = useState({ left: false, right: false });
  const updateTabScrollHints = useCallback(() => {
    const viewport = tabsViewportRef.current;
    if (!viewport) return;
    const next = {
      left: viewport.scrollLeft > 1,
      right: viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 1,
    };
    setTabScrollHints((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);
  const linkedViewsListId = useId();
  const [linkedViewsExpanded, setLinkedViewsExpanded] = useState(false);
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
  const [formatRequest, setFormatRequest] = useState<{ propId: string; token: string } | null>(null);

  useEffect(() => {
    const viewport = tabsViewportRef.current;
    const tabs = viewport?.firstElementChild;
    if (!viewport || !tabs) return;
    updateTabScrollHints();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTabScrollHints);
    observer?.observe(viewport);
    observer?.observe(tabs);
    window.addEventListener('resize', updateTabScrollHints);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateTabScrollHints);
    };
  }, [database.views, updateTabScrollHints]);

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
            <div className="db-view-controls">
              <div
                ref={tabsViewportRef}
                className={`db-tabs-viewport${tabScrollHints.left ? ' has-left-overflow' : ''}${
                  tabScrollHints.right ? ' has-right-overflow' : ''
                }`}
                onScroll={updateTabScrollHints}
              >
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
                </div>
              </div>
              {canEdit && (
                <button
                  type="button"
                  className="icon-button small db-add-view"
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
            requestedFormat={formatRequest}
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
            canEditNow={canEditNow}
            onRequestFilter={(propId) => setFilterRequest({ propId, token: newId() })}
            onRequestFormat={(propId) => setFormatRequest({ propId, token: newId() })}
          />
        )}
        {view.type === 'board' && (
          <BoardView dbId={page.id} database={database} view={view} rows={rows} editable={canEdit} />
        )}
        {view.type === 'calendar' && (
          <CalendarView dbId={page.id} database={database} view={view} rows={rows} editable={canEdit} />
        )}
        {view.type === 'list' && <ListView rows={rows} props={visible} database={database} view={view} />}
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
          <section className="db-linked-views">
            <button
              type="button"
              className="db-linked-views-toggle"
              aria-expanded={linkedViewsExpanded}
              aria-controls={linkedViewsListId}
              onClick={() => setLinkedViewsExpanded((expanded) => !expanded)}
            >
              <ChevronRight size={14} aria-hidden="true" />
              <span>{t('database.linkedViews')}</span>
            </button>
            <nav
              id={linkedViewsListId}
              className="db-linked-views-list"
              aria-label={t('database.linkedViews')}
              hidden={!linkedViewsExpanded}
            >
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
          </section>
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
  const [activePopover, setActivePopover] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  const updateDraft = (id: string, change: Partial<FilterRule>, enabled?: boolean) =>
    onChange(
      drafts.map((draft) =>
        draft.rule.id === id
          ? { ...draft, rule: { ...draft.rule, ...change }, enabled: enabled ?? draft.enabled }
          : draft,
      ),
    );

  const addQuickFilter = () => {
    const id = newId();
    onChange([
      ...drafts,
      {
        rule: { id, prop: TITLE_PROP, op: 'contains', value: '' },
        enabled: true,
      },
    ]);
  };

  if (drafts.length === 0) {
    return (
      <div className="db-filter-bar" role="region" aria-label={t('database.filterBar')}>
        <button
          type="button"
          className="db-filter-chip-add"
          onClick={addQuickFilter}
          title={t('database.addFilterChip')}
        >
          <Plus size={12} /> {t('database.addFilterChip')}
        </button>
      </div>
    );
  }

  const activeDraft = drafts.find((d) => d.rule.id === activePopover?.id);
  const activeProp = activeDraft
    ? database.properties.find((p) => p.id === activeDraft.rule.prop)
    : undefined;
  const activeType = activeDraft ? (propType(database, activeDraft.rule.prop) ?? 'text') : 'text';
  const activeOps = filterOpsFor(activeType === 'title' ? 'text' : activeType);
  const isTimestamp = activeType === 'createdTime' || activeType === 'lastEditedTime';
  const needsValue = activeDraft
    ? !['empty', 'notEmpty', 'checked', 'unchecked'].includes(activeDraft.rule.op)
    : false;
  const relationDatabaseId = activeProp?.type === 'relation' ? activeProp.relation?.targetDatabaseId : null;
  const relationDatabase = relationDatabaseId ? state.pages[relationDatabaseId] : undefined;
  const relationRows = relationDatabase?.database ? rowsOf(state, relationDatabase.id) : [];

  return (
    <div className="db-filter-bar" role="region" aria-label={t('database.filterBar')}>
      {drafts.map((draft) => {
        const { rule } = draft;
        const prop = database.properties.find((candidate) => candidate.id === rule.prop);
        const propName = prop ? prop.name : t('database.name');
        const opLabel = filterLabel(rule.op);
        const hasValue = rule.value !== null && rule.value !== '' && rule.value !== undefined;
        let valueText = '';
        if (hasValue) {
          if (prop && (prop.type === 'select' || prop.type === 'multiSelect')) {
            valueText = prop.options.find((o) => o.id === rule.value)?.name ?? String(rule.value);
          } else if (prop?.type === 'relation' && relationDatabase) {
            const relRow = state.pages[String(rule.value)];
            valueText = relRow ? displayTitle(relRow) : String(rule.value);
          } else {
            valueText = String(rule.value);
          }
        }
        return (
          <div key={rule.id} className={`db-filter-chip${draft.enabled ? ' is-active' : ''}`}>
            <button
              type="button"
              className="db-filter-chip-edit"
              aria-label={`${propName}: ${opLabel}${valueText ? ` ${valueText}` : ''}, ${t(
                draft.enabled ? 'database.searchActive' : 'database.searchInactive',
              )}. ${t('database.quickFilters')}`}
              aria-haspopup="dialog"
              aria-expanded={activePopover?.id === rule.id}
              onClick={(event) => setActivePopover({ id: rule.id, anchor: event.currentTarget })}
            >
              <span className="db-filter-chip-prop">{propName}</span>
              <span className="db-filter-chip-state">
                {t(draft.enabled ? 'database.searchActive' : 'database.searchInactive')}
              </span>
            </button>
            <button
              type="button"
              className="db-filter-chip-remove"
              aria-label={t('database.removeFilter')}
              title={t('database.removeFilter')}
              onClick={() => {
                if (activePopover?.id === rule.id) setActivePopover(null);
                onChange(drafts.filter((candidate) => candidate.rule.id !== rule.id));
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="db-filter-chip-add"
        onClick={addQuickFilter}
        title={t('database.addFilterChip')}
      >
        <Plus size={12} /> {t('database.addFilterChip')}
      </button>
      <button
        type="button"
        className="link-button db-filter-reset"
        onClick={() => {
          setActivePopover(null);
          onChange([]);
        }}
      >
        {t('database.resetFilters')}
      </button>
      <span className="db-filter-temporary-note" role="note">
        <Info size={12} aria-hidden="true" /> {t('database.quickFiltersHint')}
      </span>

      {activePopover && activeDraft && (
        <Popover
          anchor={activePopover.anchor}
          onClose={() => setActivePopover(null)}
          label={t('database.compactFilter')}
          className="db-panel"
        >
          <div className="db-filter-popover-content">
            <label className="field">
              <span>{t('database.property')}</span>
              <select
                className="text-input small"
                value={activeDraft.rule.prop}
                onChange={(event) => {
                  const nextType = propType(database, event.target.value) ?? 'text';
                  updateDraft(
                    activeDraft.rule.id,
                    {
                      prop: event.target.value,
                      op: filterOpsFor(nextType === 'title' ? 'text' : nextType)[0]!,
                      value: null,
                    },
                    true,
                  );
                }}
              >
                {names.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('database.condition')}</span>
              <select
                className="text-input small"
                value={activeDraft.rule.op}
                onChange={(event) => {
                  const op = event.target.value as FilterOp;
                  updateDraft(activeDraft.rule.id, { op, value: null }, true);
                }}
              >
                {activeOps.map((op) => (
                  <option key={op} value={op}>
                    {filterLabel(op)}
                  </option>
                ))}
              </select>
            </label>
            {needsValue && (
              <label className="field">
                <span>{t('database.value')}</span>
                {activeProp && (activeProp.type === 'select' || activeProp.type === 'multiSelect') ? (
                  <select
                    className="text-input small"
                    value={String(activeDraft.rule.value ?? '')}
                    onChange={(event) =>
                      updateDraft(activeDraft.rule.id, { value: event.target.value }, true)
                    }
                  >
                    <option value="">{t('database.choose')}</option>
                    {activeProp.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                ) : activeProp?.type === 'relation' && relationDatabaseId ? (
                  <select
                    className="text-input small"
                    value={String(activeDraft.rule.value ?? '')}
                    onChange={(event) =>
                      updateDraft(activeDraft.rule.id, { value: event.target.value }, true)
                    }
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
                    type={
                      activeProp && isNumericPropertyType(activeProp.type)
                        ? 'number'
                        : isTimestamp || activeProp?.type === 'datetime'
                          ? 'datetime-local'
                          : activeProp?.type === 'date' || activeProp?.type === 'time'
                            ? activeProp.type
                            : 'text'
                    }
                    step={activeProp && isNumericPropertyType(activeProp.type) ? 'any' : undefined}
                    value={ruleValueForInput(activeDraft.rule.value, activeProp, activeType)}
                    onChange={(event) => {
                      const raw = event.target.value;
                      const value =
                        raw === ''
                          ? ''
                          : ruleValueFromInput(raw, activeDraft.rule.value, activeProp, activeType);
                      updateDraft(activeDraft.rule.id, { value }, true);
                    }}
                  />
                )}
              </label>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={activeDraft.enabled}
                onChange={(event) => updateDraft(activeDraft.rule.id, {}, event.target.checked)}
              />
              <span>{t('database.activeQuickFilters', { count: 1 })}</span>
            </label>
          </div>
        </Popover>
      )}
    </div>
  );
}

type ToolPanel = 'options' | 'filter' | 'sort' | 'properties' | 'layout' | 'summary' | 'format';

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
  requestedFormat,
}: {
  dbId: PageId;
  scopePageId: PageId;
  database: DatabaseDef;
  view: ViewDef;
  rows: PageMeta[];
  editable: boolean;
  requestedFilter: { propId: string; token: string } | null;
  requestedFormat: { propId: string; token: string } | null;
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
    const duplicate =
      controls.filter((item) => item.name.trim().toLocaleLowerCase() === foldedName).length > 1;
    return duplicate ? `${control.name} · ${control.id.slice(-6)}` : control.name;
  };
  const groups = filterGroupsForView(view);
  const filterCount = groups.reduce((count, group) => count + group.filters.length, 0);
  const activeCount = filterCount + (view.search?.trim() ? 1 : 0);
  const updateGroups = (change: (groups: FilterGroup[]) => FilterGroup[]) =>
    saveView((current) => withFilterGroups(current, change(filterGroupsForView(current))));
  const optionsButton = useRef<HTMLButtonElement>(null);
  const handledFormatRequest = useRef<string | null>(null);
  const formatDismissReasonRef = useRef<'escape' | 'dismiss' | null>(null);
  const formatEscapeCloseHandledRef = useRef(false);
  const [formatDefaultProp, setFormatDefaultProp] = useState(TITLE_PROP);
  const [formulaDrafts, setFormulaDrafts] = useState<Record<string, string>>({});
  const [formulaDraftErrors, setFormulaDraftErrors] = useState<Record<string, FormulaDiagnosticPresentation>>({});
  const [simpleValueDrafts, setSimpleValueDrafts] = useState<Record<string, string>>({});
  const [ruleDraftErrors, setRuleDraftErrors] = useState<Record<string, string>>({});
  const [conditionalColorDrafts, setConditionalColorDrafts] = useState<Record<string, string>>({});
  const [conditionalColorDraftErrors, setConditionalColorDraftErrors] = useState<Record<string, true>>({});
  const [collapsedConditionalRules, setCollapsedConditionalRules] = useState<Set<string>>(() => new Set());
  const conditionalRuleContentPrefix = useId();
  const handledFilterRequest = useRef<string | null>(null);
  const updateGroupsRef = useRef(updateGroups);
  useEffect(() => {
    updateGroupsRef.current = updateGroups;
  });
  useEffect(() => {
    formatDismissReasonRef.current = null;
    formatEscapeCloseHandledRef.current = false;
    if (panel?.kind !== 'format') return;
    const markEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      formatDismissReasonRef.current = 'escape';
      formatEscapeCloseHandledRef.current = false;
    };
    const clearUnhandledEscape = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        formatDismissReasonRef.current === 'escape' &&
        !formatEscapeCloseHandledRef.current
      )
        formatDismissReasonRef.current = null;
    };
    window.addEventListener('keydown', markEscape, true);
    window.addEventListener('keyup', clearUnhandledEscape, true);
    return () => {
      window.removeEventListener('keydown', markEscape, true);
      window.removeEventListener('keyup', clearUnhandledEscape, true);
    };
  }, [panel?.kind]);
  useEffect(() => {
    const anchor = optionsButton.current;
    if (
      !editable ||
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
  }, [database, editable, requestedFilter]);
  useEffect(() => {
    if (
      !editable ||
      !requestedFormat ||
      handledFormatRequest.current === requestedFormat.token ||
      !optionsButton.current ||
      !database.properties.some((prop) => prop.id === requestedFormat.propId)
    )
      return;
    handledFormatRequest.current = requestedFormat.token;
    setFormatDefaultProp(requestedFormat.propId);
    setPanel({ kind: 'format', anchor: optionsButton.current });
  }, [database, editable, requestedFormat]);
  const closeFormatPanel = () => {
    const cancelDrafts = formatDismissReasonRef.current === 'escape';
    formatDismissReasonRef.current = cancelDrafts ? 'escape' : 'dismiss';
    formatEscapeCloseHandledRef.current = cancelDrafts;

    if (!cancelDrafts) {
      const pendingPatches = new Map<string, Partial<ConditionalFormatRule>>();
      for (const [key, value] of Object.entries(conditionalColorDrafts)) {
        const field = key.endsWith(':textColor')
          ? 'textColor'
          : key.endsWith(':color')
            ? 'color'
            : null;
        if (!field) continue;
        const ruleId = key.slice(0, -(field.length + 1));
        const rule = view.conditionalFormats?.find((candidate) => candidate.id === ruleId);
        const hex = validHexColor(value);
        if (!rule || !hex) continue;

        const patch = { ...(pendingPatches.get(ruleId) ?? {}) };
        if (field === 'color') patch.color = hex;
        else patch.textColor = hex;
        if (conditionalFormatRuleConfigurationIssue({ ...rule, ...patch }, database, state)) continue;
        pendingPatches.set(ruleId, patch);
      }

      if (pendingPatches.size > 0) {
        saveView((current) => ({
          ...current,
          conditionalFormats: (current.conditionalFormats ?? []).map((rule) => {
            const patch = pendingPatches.get(rule.id);
            return patch ? { ...rule, ...patch } : rule;
          }),
        }));
      }
    }

    setConditionalColorDrafts({});
    setConditionalColorDraftErrors({});
    setPanel(null);
  };
  const removeConditionalRule = (ruleId: string) => {
    setFormulaDrafts((current) => {
      const next = { ...current };
      delete next[ruleId];
      return next;
    });
    setFormulaDraftErrors((current) => {
      const next = { ...current };
      delete next[ruleId];
      return next;
    });
    setSimpleValueDrafts((current) => {
      const next = { ...current };
      delete next[ruleId];
      return next;
    });
    setRuleDraftErrors((current) => {
      const next = { ...current };
      delete next[ruleId];
      return next;
    });
    setConditionalColorDrafts((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => key !== `${ruleId}:color` && key !== `${ruleId}:textColor`,
        ),
      ),
    );
    setConditionalColorDraftErrors((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key]) => key !== `${ruleId}:color` && key !== `${ruleId}:textColor`,
        ),
      ),
    );
    setCollapsedConditionalRules((current) => {
      const next = new Set(current);
      next.delete(`${view.id}:${ruleId}`);
      return next;
    });
    saveView((current) => withoutConditionalFormatRule(current, ruleId));
  };
  return (
    <div className="db-tools">
      <button
        ref={optionsButton}
        type="button"
        className={`text-tool db-options-button${panel?.kind === 'options' ? ' is-active' : ''}`}
        onClick={open('options')}
        title={t('database.tableOptions')}
        aria-label={t('database.tableOptionsState', {
          filters: filterCount,
          sorts: view.sorts.length,
          search: view.search?.trim() ? t('database.searchActive') : t('database.searchInactive'),
        })}
        aria-haspopup="dialog"
        aria-expanded={panel?.kind === 'options'}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        <span>{t('database.options')}</span>
        {filterCount > 0 && (
          <span className="db-options-count" aria-hidden="true">
            <Filter size={10} /> {filterCount}
          </span>
        )}
        {view.sorts.length > 0 && (
          <span className="db-options-count" aria-hidden="true">
            <ArrowDownUp size={10} /> {view.sorts.length}
          </span>
        )}
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
            disabled={!editable}
            onClick={() => saveView((current) => ({ ...current, filters: [], filterGroups: [], search: '' }))}
          >
            {t('database.clearFilters')}
          </button>
        </div>
      )}
      {panel?.kind === 'options' && (
        <Popover
          anchor={panel.anchor}
          onClose={() => {
            setConditionalColorDrafts({});
            setConditionalColorDraftErrors({});
            setPanel(null);
          }}
          label={t('database.tableOptions')}
          className="db-panel"
        >
          <div className="db-options-menu">
            <button
              type="button"
              className="db-options-item"
              disabled={!editable}
              onClick={() => setPanel({ kind: 'filter', anchor: panel.anchor })}
            >
              <Filter size={14} />
              <span>{t('database.filter')}</span>
              {filterCount > 0 && <span className="db-options-item-badge">{filterCount}</span>}
            </button>
            <button
              type="button"
              className="db-options-item"
              disabled={!editable}
              onClick={() => setPanel({ kind: 'sort', anchor: panel.anchor })}
            >
              <ArrowDownUp size={14} />
              <span>{t('database.sort')}</span>
              {view.sorts.length > 0 && <span className="db-options-item-badge">{view.sorts.length}</span>}
            </button>
            <button
              type="button"
              className="db-options-item"
              disabled={!editable}
              onClick={() => setPanel({ kind: 'layout', anchor: panel.anchor })}
            >
              <Settings2 size={14} />
              <span>{t('slash.sections.layout')}</span>
            </button>
            <button
              type="button"
              className="db-options-item"
              onClick={() => setPanel({ kind: 'properties', anchor: panel.anchor })}
            >
              <Eye size={14} />
              <span>{t('database.properties')}</span>
            </button>
            <button
              type="button"
              className="db-options-item"
              disabled={!editable}
              onClick={() => setPanel({ kind: 'summary', anchor: panel.anchor })}
            >
              <Calculator size={14} />
              <span>{t('database.calculate')}</span>
            </button>
            <button
              type="button"
              className="db-options-item"
              disabled={!editable}
              onClick={() => {
                setFormatDefaultProp(TITLE_PROP);
                setPanel({ kind: 'format', anchor: panel.anchor });
              }}
            >
              <Paintbrush size={14} />
              <span>{t('database.conditionalFormatting')}</span>
              {(view.conditionalFormats?.length ?? 0) > 0 && (
                <span className="db-options-item-badge">{view.conditionalFormats!.length}</span>
              )}
            </button>

            <div className="db-options-separator" />

            <label className="db-options-toggle">
              <span>{t('database.hideTitle')}</span>
              <input
                type="checkbox"
                checked={view.hideTitle === true}
                disabled={!editable}
                onChange={(event) => saveView((current) => ({ ...current, hideTitle: event.target.checked }))}
              />
            </label>
            <label className="db-options-toggle">
              <span>{t('database.collapseDatabase')}</span>
              <input
                type="checkbox"
                checked={view.collapsed === true}
                disabled={!editable}
                onChange={(event) => saveView((current) => ({ ...current, collapsed: event.target.checked }))}
              />
            </label>

            <div className="db-options-separator" />

            <div style={{ padding: '4px 10px' }}>
              <span className="muted small" style={{ fontWeight: 600 }}>
                {t('database.linkedViewsMap')}
              </span>
              {(() => {
                const links = linkedViewReferences(state, dbId);
                if (links.length === 0) {
                  return (
                    <p className="muted small" style={{ margin: '4px 0' }}>
                      {t('database.noLinkedViews')}
                    </p>
                  );
                }
                return links.map((ref, idx) => {
                  const host = state.pages[ref.hostPageId];
                  return host ? (
                    <button
                      key={idx}
                      type="button"
                      className="db-options-item"
                      style={{ padding: '4px 0' }}
                      onClick={() => openPage(host.id)}
                    >
                      <LinkIcon size={12} />
                      <span>
                        {displayTitle(host)} · {ref.viewName || t('database.linkedView')}
                      </span>
                    </button>
                  ) : null;
                });
              })()}
            </div>
          </div>
        </Popover>
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
                const needsValue =
                  !rule.controlRef && !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
                const boundControl = rule.controlRef
                  ? state.pages[rule.controlRef.pageId]?.controls.find(
                      (item) => item.id === rule.controlRef!.controlId,
                    )
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
                    {formulaRule ? (
                      <div className="db-formula-filter">
                        <label className="field">
                          <span>{t('controls.formula')}</span>
                          <textarea
                            className="text-input small"
                            rows={3}
                            value={rule.formula ?? ''}
                            placeholder={t('controls.filterFormulaPlaceholder')}
                            onChange={(event) => {
                              const formula = event.target.value;
                              const formulaBindings = bindPageFormulaReferences(
                                formula,
                                scopePageId,
                                state,
                                dbId,
                                rule.formulaBindings ?? [],
                              );
                              change({ formula, formulaBindings });
                            }}
                          />
                        </label>
                        <label className="field">
                          <span>{t('controls.insertReference')}</span>
                          <select
                            className="text-input small"
                            defaultValue=""
                            onChange={(event) => {
                              const control = controls.find((item) => item.id === event.target.value);
                              if (!control) return;
                              const source = namedControlIdentifier(control.name);
                              const formula = rule.formula ?? '';
                              const start = formula.length + (formula.trim() ? 1 : 0);
                              const nextFormula = `${formula}${formula.trim() ? ' ' : ''}${source}`;
                              const formulaBindings = [
                                ...(rule.formulaBindings ?? []).filter(
                                  (binding) =>
                                    nextFormula.slice(binding.start, binding.end) === binding.source,
                                ),
                                {
                                  kind: 'control' as const,
                                  pageId: scopePageId,
                                  controlId: control.id,
                                  start,
                                  end: start + source.length,
                                  source,
                                },
                              ];
                              change({ formula: nextFormula, formulaBindings });
                              event.target.value = '';
                            }}
                          >
                            <option value="">{t('controls.chooseReference')}</option>
                            {controls.map((control) => (
                              <option key={control.id} value={control.id}>
                                {controlChoiceLabel(control)}
                              </option>
                            ))}
                          </select>
                        </label>
                        {rule.formulaBindings
                          ?.filter((binding) => binding.kind === 'ambiguous')
                          .map((binding) => (
                            <p className="named-data-diagnostic" key={`${binding.start}:${binding.end}`}>
                              {t('controls.ambiguousReference', { name: binding.source })}
                            </p>
                          ))}
                      </div>
                    ) : (
                      <>
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
                          value={
                            rule.controlRef ? `${rule.controlRef.pageId}:${rule.controlRef.controlId}` : ''
                          }
                          onChange={(event) => {
                            if (!event.target.value) change({ controlRef: undefined });
                            else {
                              const [pageId, ...rest] = event.target.value.split(':');
                              change({ controlRef: { pageId: pageId!, controlId: rest.join(':') } });
                            }
                          }}
                        >
                          <option value="">{t('controls.directValue')}</option>
                          {boundControl &&
                            rule.controlRef &&
                            !controls.some((item) => item.id === rule.controlRef!.controlId) && (
                              <option value={`${rule.controlRef.pageId}:${rule.controlRef.controlId}`}>
                                {t('controls.referenceControl', {
                                  name: `${boundControl.name} · ${boundControl.id.slice(-6)}`,
                                })}
                              </option>
                            )}
                          {controls.map((control) => (
                            <option key={control.id} value={`${scopePageId}:${control.id}`}>
                              {controlChoiceLabel(control)}
                            </option>
                          ))}
                        </select>
                        {rule.controlRef && !boundControl && (
                          <p className="named-data-diagnostic">
                            {t('controls.missingControl', { name: rule.controlRef.controlId })}
                          </p>
                        )}
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
                                change({
                                  value: ruleValueFromInput(event.target.value, rule.value, prop, type),
                                })
                              }
                            />
                          ))}
                      </>
                    )}
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
                onClick={() =>
                  updateGroups((current) =>
                    current.map((item) =>
                      item.id === group.id
                        ? {
                            ...item,
                            filters: [
                              ...item.filters,
                              {
                                id: newId(),
                                prop: '$formula',
                                op: 'is',
                                value: null,
                                formula: '',
                                formulaBindings: [],
                              },
                            ],
                          }
                        : item,
                    ),
                  )
                }
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
          {names.map((item) => {
            const prop = database.properties.find((candidate) => candidate.id === item.id);
            const operations = operationsForProp(prop);
            return (
              <label key={item.id} className="field">
                <span>{item.name}</span>
                <select
                  className="text-input small"
                  value={view.summaries?.[item.id] ?? ''}
                  onChange={(event) =>
                    saveView((current) => {
                      const summaries = { ...current.summaries };
                      if (event.target.value) summaries[item.id] = event.target.value as SummaryOperation;
                      else delete summaries[item.id];
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
          onClose={closeFormatPanel}
          label={t('database.conditionalFormatting')}
          className="db-panel"
        >
          {(view.unsupportedConditionalFormats ?? []).map((entry) => (
            <div
              key={`unsupported-${entry.index}-${entry.beforeRuleId ?? ''}-${entry.afterRuleId ?? ''}`}
              className="db-formula-diagnostic warning"
              role="status"
            >
              {conditionalDiagnosticText({
                code: 'unsupportedRule',
                index: entry.index,
                message: entry.reason,
              })}
            </div>
          ))}
          {(view.conditionalFormats ?? []).map((rule, ruleIndex) => {
            const prop = database.properties.find((candidate) => candidate.id === rule.prop);
            const type = propType(database, rule.prop) ?? 'text';
            const criterionType: PropType | 'title' = type === 'title'
              ? 'text'
              : type === 'formula'
                ? prop?.formulaResultType && prop.formulaResultType !== 'formula'
                  ? prop.formulaResultType
                  : 'text'
                : type;
            const value = ruleValueForInput(rule.value, prop, criterionType);
            const displayedValue = simpleValueDrafts[rule.id] ?? value;
            const needsValue = !['empty', 'notEmpty', 'checked', 'unchecked'].includes(rule.op);
            const canClearBackground = rule.textColor !== undefined || rule.bold !== undefined || rule.italic !== undefined;
            const canClearTextColor = rule.color !== undefined || rule.bold !== undefined || rule.italic !== undefined;
            const editRule = (patch: Partial<ConditionalFormatRule>) => {
              const candidate = { ...rule, ...patch };
              const issue = conditionalFormatRuleConfigurationIssue(candidate, database, state);
              if (issue) {
                setRuleDraftErrors((current) => ({
                  ...current,
                  [rule.id]: conditionalDiagnosticText({ ...issue, ruleId: rule.id }),
                }));
                return false;
              }
              setRuleDraftErrors((current) => {
                const next = { ...current };
                delete next[rule.id];
                return next;
              });
              setSimpleValueDrafts((current) => {
                const next = { ...current };
                delete next[rule.id];
                return next;
              });
              saveView((current) => ({
                ...current,
                conditionalFormats: (current.conditionalFormats ?? []).map((candidate) =>
                  candidate.id === rule.id ? { ...candidate, ...patch } : candidate,
                ),
              }));
              return true;
            };
            const colorDraftKey = (field: 'color' | 'textColor') => `${rule.id}:${field}`;
            const updateColorDraft = (field: 'color' | 'textColor', value: string) => {
              const key = colorDraftKey(field);
              setConditionalColorDrafts((current) => ({ ...current, [key]: value }));
              setConditionalColorDraftErrors((current) => {
                const next = { ...current };
                if (validHexColor(value)) delete next[key];
                else next[key] = true;
                return next;
              });
            };
            const clearColorDraft = (field: 'color' | 'textColor') => {
              const key = colorDraftKey(field);
              setConditionalColorDrafts((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
              setConditionalColorDraftErrors((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
            };
            const commitColorDraft = (field: 'color' | 'textColor') => {
              const key = colorDraftKey(field);
              const value = conditionalColorDrafts[key];
              if (value === undefined) return;
              const hex = validHexColor(value);
              if (!hex) {
                setConditionalColorDraftErrors((current) => ({ ...current, [key]: true }));
                return;
              }
              const saved = field === 'color' ? editRule({ color: hex }) : editRule({ textColor: hex });
              if (saved) clearColorDraft(field);
            };
            const changeRuleProperty = (propId: string) => {
              const property = database.properties.find((candidate) => candidate.id === propId);
              const rawType = propType(database, propId) ?? 'text';
              const criterionType = rawType === 'title'
                ? 'text'
                : rawType === 'formula'
                  ? property?.formulaResultType && property.formulaResultType !== 'formula'
                    ? property.formulaResultType
                    : 'text'
                  : rawType;
              const op = filterOpsFor(criterionType)[0] ?? 'contains';
              const alternatives: PropValue[] = [null, 0, '', dateKey(new Date()), '00:00', new Date().toISOString()];
              const value = alternatives.find((candidate) =>
                !conditionalFormatRuleConfigurationIssue({ ...rule, prop: propId, op, value: candidate }, database, state),
              ) ?? null;
              editRule({ prop: propId, op, value });
            };
            const sampleRow = rows[0] ?? ({ id: 'sample', properties: {} } as PageMeta);
            const diagnosticView = { ...view, conditionalFormats: [rule], unsupportedConditionalFormats: [] };
            const resolvedRule = rule.scope === 'cell'
              ? resolveConditionalFormatForCell(sampleRow, rule.prop, diagnosticView, database, state)
              : resolveConditionalFormatForRow(sampleRow, diagnosticView, database, state);
            const ruleDiagnostic = resolvedRule.diagnostics.find((diagnostic) => diagnostic.ruleId === rule.id);
            const formulaDraftError = formulaDraftErrors[rule.id];
            const ruleDraftError = ruleDraftErrors[rule.id];
            const backgroundColorDraftKey = colorDraftKey('color');
            const textColorDraftKey = colorDraftKey('textColor');
            const backgroundColorDraftError = conditionalColorDraftErrors[backgroundColorDraftKey];
            const textColorDraftError = conditionalColorDraftErrors[textColorDraftKey];
            const formulaErrorDetail = formulaDraftError
              ? formulaDraftError.technicalDetail
              : ruleDraftError
                ? null
                : ruleDiagnostic
                  ? conditionalDiagnosticTechnicalDetail(ruleDiagnostic)
                  : null;
            const collapsedRuleKey = `${view.id}:${rule.id}`;
            const isCollapsed = collapsedConditionalRules.has(collapsedRuleKey);
            const contentId = `${conditionalRuleContentPrefix}-rule-${ruleIndex}`;
            const propertyName = prop?.name ?? rule.prop;
            const summaryCriterion = rule.mode === 'formula' ? t('database.formulaCondition') : filterLabel(rule.op);
            const summaryValue = rule.mode === 'formula'
              ? formulaDrafts[rule.id] ?? rule.formula ?? '—'
              : displayedValue || '—';
            const summarizeColor = (color: ColorValue | undefined, field: 'color' | 'textColor') => {
              const draft = conditionalColorDrafts[colorDraftKey(field)];
              if (draft !== undefined) return draft;
              if (color === undefined) return t(field === 'color' ? 'database.noBackground' : 'database.noTextColor');
              return validHexColor(color) ?? colorLabel(color as ColorName);
            };
            const appearanceSummary = [
              `${t('database.backgroundColor')}: ${summarizeColor(rule.color, 'color')}`,
              `${t('database.textColor')}: ${summarizeColor(rule.textColor, 'textColor')}`,
              `${t('database.bold')}: ${rule.bold === undefined ? t('database.conditionalStyleDefault') : rule.bold ? t('database.conditionalStyleOn') : t('database.conditionalStyleOff')}`,
              `${t('database.italic')}: ${rule.italic === undefined ? t('database.conditionalStyleDefault') : rule.italic ? t('database.conditionalStyleOn') : t('database.conditionalStyleOff')}`,
            ].join(', ');
            const summary = t('database.conditionalRuleSummary', {
              property: propertyName,
              criterion: summaryCriterion,
              value: summaryValue,
              scope: t(rule.scope === 'row' ? 'database.entireRow' : 'database.matchingCell'),
              appearance: appearanceSummary,
            });
            const previewBackgroundDraft = conditionalColorDrafts[backgroundColorDraftKey];
            const previewTextDraft = conditionalColorDrafts[textColorDraftKey];
            const previewBackground = validHexColor(previewBackgroundDraft) ?? rule.color;
            const previewText = validHexColor(previewTextDraft) ?? rule.textColor;
            const previewStyle = conditionalFormatStyle({
              backgroundColor: previewBackground,
              textColor: previewText,
              bold: rule.bold,
              italic: rule.italic,
              matchedRuleIds: [],
              diagnostics: [],
            });
            const backgroundSample = previewBackground === undefined
              ? null
              : validHexColor(previewBackground) ?? BACKGROUND_HEX[previewBackground as ColorName] ?? '#fbf3db';
            const textSample = previewText === undefined
              ? null
              : validHexColor(previewText) ?? TEXT_HEX[previewText as ColorName] ?? '#202124';

            return (
              <section
                key={rule.id}
                data-conditional-format-rule={rule.id}
                className="db-conditional-rule"
                aria-labelledby={`${contentId}-heading`}
              >
                <header className="db-conditional-rule-header">
                  <div className="db-conditional-rule-heading">
                    <strong id={`${contentId}-heading`}>
                      {t('database.conditionalRuleCard', { number: ruleIndex + 1 })}
                    </strong>
                    <div className="db-conditional-rule-summary" role="group" aria-label={summary}>
                      <span>{propertyName}</span>
                      <span>{summaryCriterion}</span>
                      <span>{summaryValue}</span>
                      <span>{t(rule.scope === 'row' ? 'database.entireRow' : 'database.matchingCell')}</span>
                      {backgroundSample && (
                        <span
                          className="db-conditional-color-swatch"
                          style={{ backgroundColor: backgroundSample }}
                          aria-hidden="true"
                        />
                      )}
                      {textSample && (
                        <span
                          className="db-conditional-text-swatch"
                          style={{ color: textSample }}
                          aria-hidden="true"
                        >
                          Aa
                        </span>
                      )}
                      <span
                        className="db-conditional-summary-preview"
                        style={previewStyle}
                        aria-hidden="true"
                      >
                        Aa
                      </span>
                    </div>
                  </div>
                  <div className="db-conditional-rule-actions">
                    <button
                      type="button"
                      className="icon-button tiny"
                      data-conditional-rule-toggle="true"
                      aria-controls={contentId}
                      aria-expanded={!isCollapsed}
                      aria-label={t(
                        isCollapsed ? 'database.expandConditionalRule' : 'database.collapseConditionalRule',
                        {
                          number: ruleIndex + 1,
                        },
                      )}
                      onClick={() =>
                        setCollapsedConditionalRules((current) => {
                          const next = new Set(current);
                          if (next.has(collapsedRuleKey)) next.delete(collapsedRuleKey);
                          else next.add(collapsedRuleKey);
                          return next;
                        })
                      }
                    >
                      {isCollapsed ? (
                        <ChevronRight size={14} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={14} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-button tiny danger"
                      aria-label={t('database.removeConditionalRule')}
                      onClick={() => {
                        const targetRuleId = rule.id;
                        confirmAction({
                          title: t('database.removeConditionalRuleConfirmTitle', { number: ruleIndex + 1 }),
                          body: t('database.removeConditionalRuleConfirmBody', { summary }),
                          confirmLabel: t('common.remove'),
                          danger: true,
                          onConfirm: () => removeConditionalRule(targetRuleId),
                        });
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  </div>
                </header>
                <div id={contentId} className="db-conditional-rule-content" hidden={isCollapsed}>
                  <div className="db-conditional-rule-targets">
                    <label className="db-conditional-field">
                      <span>{t('database.ruleMode')}</span>
                      <select
                        className="text-input small"
                        aria-label={t('database.ruleMode')}
                        value={rule.mode ?? 'simple'}
                        onChange={(event) => {
                          if (event.target.value === 'formula') {
                            const formula = rule.formula?.trim() ? rule.formula : 'false';
                            setFormulaDrafts((current) => ({ ...current, [rule.id]: formula }));
                            setFormulaDraftErrors((current) => {
                              const next = { ...current };
                              delete next[rule.id];
                              return next;
                            });
                            setRuleDraftErrors((current) => ({ ...current, [rule.id]: '' }));
                            editRule({ mode: 'formula', formula });
                          } else {
                            setFormulaDrafts((current) => {
                              const next = { ...current };
                              delete next[rule.id];
                              return next;
                            });
                            setFormulaDraftErrors((current) => {
                              const next = { ...current };
                              delete next[rule.id];
                              return next;
                            });
                            setRuleDraftErrors((current) => {
                              const next = { ...current };
                              delete next[rule.id];
                              return next;
                            });
                            editRule({ mode: 'simple', formula: '', formulaBindings: undefined });
                          }
                        }}
                      >
                        <option value="simple">{t('database.simpleCondition')}</option>
                        <option value="formula">{t('database.formulaCondition')}</option>
                      </select>
                    </label>
                    <label className="db-conditional-field">
                      <span>{t('database.property')}</span>
                      <select
                        className="text-input small"
                        aria-label={t('database.property')}
                        value={rule.prop}
                        onChange={(event) => changeRuleProperty(event.target.value)}
                      >
                        {names.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="db-conditional-field">
                      <span>{t('database.conditionScope')}</span>
                      <select
                        className="text-input small"
                        aria-label={t('database.conditionScope')}
                        value={rule.scope}
                        onChange={(event) =>
                          editRule({ scope: event.target.value === 'cell' ? 'cell' : 'row' })
                        }
                      >
                        <option value="row">{t('database.entireRow')}</option>
                        <option value="cell">{t('database.matchingCell')}</option>
                      </select>
                    </label>
                  </div>

                  {rule.mode === 'formula' ? (
                    <label className="db-conditional-field db-conditional-field-full">
                      <span>{t('database.ruleFormula')}</span>
                      <input
                        type="text"
                        className="text-input small"
                        placeholder="e.g. Score >= 50 and Status = 'Done'"
                        aria-label={t('database.ruleFormula')}
                        value={formulaDrafts[rule.id] ?? rule.formula ?? ''}
                        onChange={(event) => {
                          const formula = event.target.value;
                          setFormulaDrafts((current) => ({ ...current, [rule.id]: formula }));
                          if (!formula.trim()) {
                            setFormulaDraftErrors((current) => ({
                              ...current,
                              [rule.id]: {
                                primary: t('database.conditionalRuleFormulaRequired'),
                                technicalDetail: null,
                              },
                            }));
                            return;
                          }
                          try {
                            parseFormula(formula);
                          } catch (error) {
                            setFormulaDraftErrors((current) => ({
                              ...current,
                              [rule.id]: localizedFormulaDiagnostic(
                                error instanceof Error ? error.message : String(error),
                              ),
                            }));
                            return;
                          }
                          setFormulaDraftErrors((current) => {
                            const next = { ...current };
                            delete next[rule.id];
                            return next;
                          });
                          const formulaBindings = bindPageFormulaReferences(
                            formula,
                            scopePageId,
                            state,
                            dbId,
                            rule.formulaBindings ?? [],
                          );
                          editRule({ formula, formulaBindings });
                        }}
                      />
                    </label>
                  ) : (
                    <div className="db-conditional-rule-conditions">
                      <label className="db-conditional-field">
                        <span>{t('database.condition')}</span>
                        <select
                          className="text-input small"
                          aria-label={t('database.condition')}
                          value={rule.op}
                          onChange={(event) => {
                            const op = event.target.value as FilterOp;
                            let nextValue = rule.value;
                            if (
                              conditionalFormatRuleConfigurationIssue(
                                { ...rule, op, value: nextValue },
                                database,
                                state,
                              )
                            ) {
                              const alternatives: PropValue[] = [
                                null,
                                0,
                                '',
                                dateKey(new Date()),
                                '00:00',
                                new Date().toISOString(),
                              ];
                              nextValue =
                                alternatives.find(
                                  (candidate) =>
                                    !conditionalFormatRuleConfigurationIssue(
                                      { ...rule, op, value: candidate },
                                      database,
                                      state,
                                    ),
                                ) ?? null;
                            }
                            editRule({ op, value: nextValue });
                          }}
                        >
                          {filterOpsFor(criterionType).map((op) => (
                            <option key={op} value={op}>
                              {filterLabel(op)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="db-conditional-field">
                        <span>{t('database.value')}</span>
                        {needsValue ? (
                          prop && (prop.type === 'select' || prop.type === 'multiSelect') ? (
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
                                isNumericPropertyType(criterionType)
                                  ? 'number'
                                  : criterionType === 'datetime' ||
                                      criterionType === 'createdTime' ||
                                      criterionType === 'lastEditedTime'
                                    ? 'datetime-local'
                                    : criterionType === 'date' || criterionType === 'time'
                                      ? criterionType
                                      : 'text'
                              }
                              step={isNumericPropertyType(criterionType) ? 'any' : undefined}
                              value={displayedValue}
                              onChange={(event) => {
                                setSimpleValueDrafts((current) => ({
                                  ...current,
                                  [rule.id]: event.target.value,
                                }));
                                editRule({
                                  value: ruleValueFromInput(
                                    event.target.value,
                                    rule.value,
                                    prop,
                                    criterionType,
                                  ),
                                });
                              }}
                            />
                          )
                        ) : (
                          <span className="db-conditional-value-not-required">—</span>
                        )}
                      </label>
                    </div>
                  )}

                  {(formulaDraftError || ruleDraftError || ruleDiagnostic) && (
                    <div className="db-formula-diagnostic error" role="alert">
                      <span className="formula-error-primary">
                        {formulaDraftError?.primary ||
                          ruleDraftError ||
                          conditionalDiagnosticText(ruleDiagnostic!)}
                      </span>
                      {formulaErrorDetail !== null && (
                        <details className="formula-error-details">
                          <summary>{t('formulaUx.technicalDetails')}</summary>
                          <code dir="auto">{formulaErrorDetail}</code>
                        </details>
                      )}
                    </div>
                  )}

                  <fieldset className="db-conditional-appearance">
                    <legend>{t('database.conditionalAppearance')}</legend>
                    <div className="db-conditional-style-controls">
                      <label className="db-conditional-style-field">
                        <span>{t('database.backgroundColor')}</span>
                        <select
                          className="text-input small"
                          aria-label={t('database.backgroundColor')}
                          value={validHexColor(rule.color) ? 'custom' : (rule.color ?? '')}
                          onChange={(event) => {
                            if (event.target.value === '' && canClearBackground) {
                              clearColorDraft('color');
                              editRule({ color: undefined });
                            } else if (event.target.value && event.target.value !== 'custom') {
                              clearColorDraft('color');
                              editRule({ color: event.target.value as ColorName });
                            }
                          }}
                        >
                          <option value="" disabled={!canClearBackground}>
                            {t('database.noBackground')}
                          </option>
                          {COLORS.map((color) => (
                            <option key={color} value={color}>
                              {colorLabel(color)}
                            </option>
                          ))}
                          <option value="custom">{t('database.customHexColor')}</option>
                        </select>
                        <span className="db-conditional-color-inputs">
                          {backgroundSample && (
                            <span
                              className="db-conditional-color-swatch"
                              style={{ backgroundColor: backgroundSample }}
                              aria-hidden="true"
                            />
                          )}
                          <input
                            type="text"
                            className="text-input small"
                            aria-label={t('database.backgroundColor')}
                            placeholder="#RRGGBB"
                            aria-invalid={Boolean(backgroundColorDraftError)}
                            value={
                              conditionalColorDrafts[backgroundColorDraftKey] ??
                              validHexColor(rule.color) ??
                              ''
                            }
                            onChange={(event) => {
                              updateColorDraft('color', event.target.value);
                            }}
                            onBlur={(event) => {
                              if (
                                event.relatedTarget instanceof HTMLElement &&
                                event.relatedTarget.closest('[data-conditional-rule-toggle]')
                              )
                                return;
                              if (formatDismissReasonRef.current === null) commitColorDraft('color');
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitColorDraft('color');
                              }
                            }}
                          />
                          <input
                            type="color"
                            aria-label={t('database.customHexColor')}
                            value={
                              validHexColor(rule.color) ??
                              (BACKGROUND_HEX[rule.color as ColorName] || '#fbf3db')
                            }
                            onChange={(event) => {
                              const hex = validHexColor(event.target.value);
                              if (hex) {
                                clearColorDraft('color');
                                editRule({ color: hex });
                              }
                            }}
                          />
                          {rule.color !== undefined && (
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t('database.clearBackground')}
                              disabled={!canClearBackground}
                              onClick={() => {
                                clearColorDraft('color');
                                editRule({ color: undefined });
                              }}
                            >
                              {t('database.noBackground')}
                            </button>
                          )}
                        </span>
                        {backgroundColorDraftError && (
                          <div
                            className="db-formula-diagnostic error"
                            role="alert"
                            data-conditional-color-error="color"
                          >
                            {t('database.conditionalColorInvalid')}
                          </div>
                        )}
                      </label>

                      <label className="db-conditional-style-field">
                        <span>{t('database.textColor')}</span>
                        <select
                          className="text-input small"
                          aria-label={t('database.textColor')}
                          value={validHexColor(rule.textColor) ? 'custom' : (rule.textColor ?? '')}
                          onChange={(event) => {
                            if (event.target.value === '' && canClearTextColor) {
                              clearColorDraft('textColor');
                              editRule({ textColor: undefined });
                            } else if (event.target.value && event.target.value !== 'custom') {
                              clearColorDraft('textColor');
                              editRule({ textColor: event.target.value as ColorName });
                            }
                          }}
                        >
                          <option value="" disabled={!canClearTextColor}>
                            {t('database.noTextColor')}
                          </option>
                          {COLORS.map((color) => (
                            <option key={color} value={color}>
                              {colorLabel(color)}
                            </option>
                          ))}
                          <option value="custom">{t('database.customHexColor')}</option>
                        </select>
                        <span className="db-conditional-color-inputs">
                          {textSample && (
                            <span
                              className="db-conditional-text-swatch"
                              style={{ color: textSample }}
                              aria-hidden="true"
                            >
                              Aa
                            </span>
                          )}
                          <input
                            type="text"
                            className="text-input small"
                            aria-label={t('database.textColor')}
                            placeholder="#RRGGBB"
                            aria-invalid={Boolean(textColorDraftError)}
                            value={
                              conditionalColorDrafts[textColorDraftKey] ?? validHexColor(rule.textColor) ?? ''
                            }
                            onChange={(event) => {
                              updateColorDraft('textColor', event.target.value);
                            }}
                            onBlur={(event) => {
                              if (
                                event.relatedTarget instanceof HTMLElement &&
                                event.relatedTarget.closest('[data-conditional-rule-toggle]')
                              )
                                return;
                              if (formatDismissReasonRef.current === null) commitColorDraft('textColor');
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitColorDraft('textColor');
                              }
                            }}
                          />
                          <input
                            type="color"
                            aria-label={t('database.textColor')}
                            value={
                              validHexColor(rule.textColor) ??
                              (TEXT_HEX[rule.textColor as ColorName] || '#202124')
                            }
                            onChange={(event) => {
                              const hex = validHexColor(event.target.value);
                              if (hex) {
                                clearColorDraft('textColor');
                                editRule({ textColor: hex });
                              }
                            }}
                          />
                          {rule.textColor !== undefined && (
                            <button
                              type="button"
                              className="link-button"
                              aria-label={t('database.clearTextColor')}
                              disabled={!canClearTextColor}
                              onClick={() => {
                                clearColorDraft('textColor');
                                editRule({ textColor: undefined });
                              }}
                            >
                              {t('database.noTextColor')}
                            </button>
                          )}
                        </span>
                        {textColorDraftError && (
                          <div
                            className="db-formula-diagnostic error"
                            role="alert"
                            data-conditional-color-error="textColor"
                          >
                            {t('database.conditionalColorInvalid')}
                          </div>
                        )}
                      </label>

                      <label className="db-conditional-style-field">
                        <span>{t('database.bold')}</span>
                        <select
                          className="text-input small"
                          aria-label={t('database.bold')}
                          value={rule.bold === undefined ? 'default' : rule.bold ? 'on' : 'off'}
                          onChange={(event) =>
                            editRule({
                              bold:
                                event.target.value === 'default' ? undefined : event.target.value === 'on',
                            })
                          }
                        >
                          <option value="default">{t('database.conditionalStyleDefault')}</option>
                          <option value="on">{t('database.conditionalStyleOn')}</option>
                          <option value="off">{t('database.conditionalStyleOff')}</option>
                        </select>
                      </label>
                      <label className="db-conditional-style-field">
                        <span>{t('database.italic')}</span>
                        <select
                          className="text-input small"
                          aria-label={t('database.italic')}
                          value={rule.italic === undefined ? 'default' : rule.italic ? 'on' : 'off'}
                          onChange={(event) =>
                            editRule({
                              italic:
                                event.target.value === 'default' ? undefined : event.target.value === 'on',
                            })
                          }
                        >
                          <option value="default">{t('database.conditionalStyleDefault')}</option>
                          <option value="on">{t('database.conditionalStyleOn')}</option>
                          <option value="off">{t('database.conditionalStyleOff')}</option>
                        </select>
                      </label>
                    </div>
                  </fieldset>

                  <div
                    className="db-format-preview"
                    role="group"
                    aria-label={t('database.rulePreview')}
                    style={previewStyle}
                  >
                    <strong>{t('database.rulePreview')}</strong>
                    <span className="db-format-preview-sample">Aa</span>
                    <span>{t(rule.scope === 'row' ? 'database.entireRow' : 'database.matchingCell')}</span>
                  </div>
                </div>
              </section>
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
                    prop: formatDefaultProp,
                    op:
                      formatDefaultProp === TITLE_PROP
                        ? 'notEmpty'
                        : filterOpsFor(propType(database, formatDefaultProp) ?? 'text')[0]!,
                    value: null,
                    scope: formatDefaultProp === TITLE_PROP ? 'row' : 'cell',
                    color: 'yellow',
                    mode: 'simple',
                    formula: '',
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
  canEditNow?: () => boolean;
}

function RowTitle({
  row,
  editable,
  canEditNow,
  autoFocus,
  gridMode,
  isEditing,
  initialText,
  onCommitAndMove,
  onCancelEdit,
  onDoneEdit,
  onInvalidDraftChange,
}: {
  row: PageMeta;
  editable: boolean;
  canEditNow?: () => boolean;
  autoFocus?: boolean;
  gridMode?: boolean;
  isEditing?: boolean;
  initialText?: string;
  onCommitAndMove?: (direction: 'down' | 'up' | 'next' | 'prev' | 'stay') => void;
  onCancelEdit?: () => void;
  onDoneEdit?: () => void;
  onInvalidDraftChange?: (invalid: boolean) => void;
}) {
  return (
    <div className="db-title">
      <span className="tree-icon">
        <PageIcon page={row} />
      </span>
      {gridMode && !isEditing ? (
        <span
          className="db-title-text"
          style={{
            flex: '1 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            padding: '0 4px',
            userSelect: 'none',
          }}
        >
          {row.title || <span className="prop-empty">{t('page.untitled')}</span>}
        </span>
      ) : (
        <DraftInput
          type="text"
          label={t('database.name')}
          className="db-title-input"
          value={row.title}
          placeholder={t('page.untitled')}
          editable={editable}
          canEditNow={canEditNow}
          autoFocus={gridMode ? true : autoFocus}
          gridMode={gridMode}
          initialDraft={initialText}
          onCommitAndMove={onCommitAndMove}
          onCancelEdit={onCancelEdit}
          onDone={onDoneEdit}
          onInvalidDraftChange={onInvalidDraftChange}
          onCommit={(title) => run({ type: 'page.rename', id: row.id, title, now: nowTimestamp() })}
        />
      )}
      {!gridMode && autoFocus && <FocusLast />}
      <button
        type="button"
        className="icon-button tiny db-open"
        tabIndex={-1}
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
    const added = updateDatabase(
      dbId,
      (current) => insertPropertyNear(current, view, property, anchorPropId, position)?.database ?? current,
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
        <PropertyTypeSelect value={type} onChange={setType} />
        <button type="submit" className="button small" disabled={!name.trim()}>
          {t('common.add')}
        </button>
      </form>
    </Popover>
  );
}

function TableView({
  dbId,
  database,
  view,
  rows,
  props,
  editable,
  canEditNow,
  onRequestFilter,
  onRequestFormat,
}: ViewProps & {
  onRequestFilter: (propId: string) => void;
  onRequestFormat: (propId: string) => void;
}) {
  const saveView = useViewUpdater(dbId, view.id);
  const state = useWorkspace();
  const canEditImmediately = () => editable && (canEditNow?.() ?? true);
  const tableRef = useRef<HTMLTableElement>(null);
  const [expandedCell, setExpandedCell] = useState<string | null>(null);

  const visibleColIds = useMemo(() => [TITLE_PROP, ...props.map((p) => p.id)], [props]);
  const visibleRowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const visibleRowIdSet = useMemo(() => new Set(visibleRowIds), [visibleRowIds]);
  const visibleRowKey = visibleRowIds.join('\u0000');
  const [rowSelection, setRowSelection] = useState<{
    visibleRowKey: string;
    ids: PageId[];
    anchor: PageId | null;
  }>(() => ({
    visibleRowKey,
    ids: [],
    anchor: null,
  }));
  if (rowSelection.visibleRowKey !== visibleRowKey) setRowSelection({ visibleRowKey, ids: [], anchor: null });
  const selectedRowIds = useMemo(
    () => (rowSelection.visibleRowKey === visibleRowKey ? rowSelection.ids : []),
    [rowSelection, visibleRowKey],
  );
  const setSelectedRowIds = (update: PageId[] | ((current: PageId[]) => PageId[])) => {
    setRowSelection((current) => {
      const currentIds = current.visibleRowKey === visibleRowKey ? current.ids : [];
      const ids = typeof update === 'function' ? update(currentIds) : update;
      return {
        visibleRowKey,
        ids: ids.filter((id) => visibleRowIdSet.has(id)),
        anchor: current.visibleRowKey === visibleRowKey ? current.anchor : null,
      };
    });
  };
  const setRowSelectionAnchor = (anchor: PageId | null) => {
    setRowSelection((current) => ({
      visibleRowKey,
      ids: current.visibleRowKey === visibleRowKey ? current.ids : [],
      anchor,
    }));
  };
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const selectedVisibleRowIds = useMemo(
    () => visibleRowIds.filter((id) => selectedRowIdSet.has(id)),
    [selectedRowIdSet, visibleRowIds],
  );
  const rowSelectionAnchor = rowSelection.visibleRowKey === visibleRowKey ? rowSelection.anchor : null;
  const headerRowSelectorRef = useRef<HTMLInputElement>(null);
  const rowSelectorRefs = useRef<Map<PageId, HTMLInputElement>>(new Map());
  const dragRowIds = useRef<PageId[]>([]);
  const [rowMenu, setRowMenu] = useState<{ rowId: PageId; anchor: HTMLElement } | null>(null);
  const [rowMappingDialog, setRowMappingDialog] = useState<RowMappingDialogState | null>(null);
  const [rowTrashConfirmation, setRowTrashConfirmation] = useState<{
    rowIds: PageId[];
    nestedCount: number;
  } | null>(null);
  const rowDialogReturnFocusRef = useRef<HTMLElement | null>(null);

  const captureRowDialogFocus = () => {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rowDialogReturnFocusRef.current = rowMenu?.anchor.isConnected ? rowMenu.anchor : active;
  };
  const restoreRowDialogFocus = () => {
    const target = rowDialogReturnFocusRef.current;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const fallbackRowId = rowTrashConfirmation?.rowIds[0] ?? visibleRowIds[0];
        const fallback = fallbackRowId ? rowSelectorRefs.current.get(fallbackRowId) : null;
        const header = headerRowSelectorRef.current;
        (target?.isConnected
          ? target
          : (fallback ?? (header && !header.disabled ? header : tableRef.current))
        )?.focus({
          preventScroll: true,
        });
        if (rowDialogReturnFocusRef.current === target) rowDialogReturnFocusRef.current = null;
      });
    });
  };
  const closeRowMappingDialog = () => {
    setRowMappingDialog(null);
    restoreRowDialogFocus();
  };
  const closeRowTrashConfirmation = () => {
    setRowTrashConfirmation(null);
    restoreRowDialogFocus();
  };

  const invalidEditingCellRef = useRef<string | null>(null);
  const clearRowSelection = () => {
    if (
      selectedRowIds.length === 0 &&
      rowSelection.visibleRowKey === visibleRowKey &&
      rowSelection.anchor === null
    )
      return;
    setSelectedRowIds([]);
    setRowSelectionAnchor(null);
  };
  const selectRowsExplicitly = (update: PageId[] | ((current: PageId[]) => PageId[])) => {
    setActiveCell(null);
    activeCellRef.current = null;
    setSelectionRange(null);
    invalidEditingCellRef.current = null;
    setEditingCell(null);
    setSelectedRowIds(update);
  };

  const changeRowSelection = (
    rowId: PageId,
    checked: boolean,
    modifiers: { shift: boolean; additive: boolean },
  ) => {
    const index = visibleRowIds.indexOf(rowId);
    if (index < 0) return;
    const anchor = rowSelectionAnchor;
    if (modifiers.shift && anchor && visibleRowIdSet.has(anchor)) {
      const anchorIndex = visibleRowIds.indexOf(anchor);
      const range = visibleRowIds.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1);
      selectRowsExplicitly((current) => {
        const next = new Set(modifiers.additive ? current : []);
        if (checked) range.forEach((id) => next.add(id));
        else range.forEach((id) => next.delete(id));
        return visibleRowIds.filter((id) => next.has(id));
      });
    } else if (modifiers.additive) {
      selectRowsExplicitly((current) => {
        const next = new Set(current);
        if (checked) next.add(rowId);
        else next.delete(rowId);
        return visibleRowIds.filter((id) => next.has(id));
      });
      setRowSelectionAnchor(rowId);
    } else {
      selectRowsExplicitly(checked ? [rowId] : []);
      setRowSelectionAnchor(rowId);
    }
  };

  const handleRowSelectorKeyDown = (event: React.KeyboardEvent<HTMLElement>, rowId: PageId) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectRowsExplicitly([...visibleRowIds]);
      setRowSelectionAnchor(rowId);
      return;
    }
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      setRowMenu({ rowId, anchor: event.currentTarget });
      return;
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const index = visibleRowIds.indexOf(rowId);
    const nextId = visibleRowIds[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!nextId) return;
    event.preventDefault();
    if (event.shiftKey)
      changeRowSelection(nextId, true, { shift: true, additive: event.ctrlKey || event.metaKey });
    rowSelectorRefs.current.get(nextId)?.focus({ preventScroll: true });
  };

  const [activeCell, setActiveCell] = useState<GridCoord | null>(() => {
    const r = visibleRowIds[0];
    const c = visibleColIds[0];
    return r && c ? { rowId: r, colId: c } : null;
  });
  const activeCellRef = useRef<GridCoord | null>(activeCell);
  useEffect(() => {
    activeCellRef.current = activeCell;
  }, [activeCell]);
  const [selectionRange, setSelectionRange] = useState<GridRange | null>(() => {
    const r = visibleRowIds[0];
    const c = visibleColIds[0];
    return r && c ? { anchor: { rowId: r, colId: c }, focus: { rowId: r, colId: c } } : null;
  });
  const [editingCell, setEditingCell] = useState<
    (GridCoord & { initialText?: string; openPickerOnEdit?: boolean }) | null
  >(null);
  const [fillPreview, setFillPreview] = useState<{
    sourceRange: GridRange;
    targetRange: GridRange;
    mode: FillModeChoice;
    previewCells: Array<{ rowId: PageId; colId: string; value: PropValue }>;
    commands: Command[];
    undoCommands: Command[];
    redoCommands: Command[];
    affectedCells: number;
    canSequence: boolean;
    error?: string;
  } | null>(null);
  const [focusFillActions, setFocusFillActions] = useState(false);
  const [lastBatchUndo, setLastBatchUndo] = useState<Command[] | null>(null);
  const [lastBatchRedo, setLastBatchRedo] = useState<Command[] | null>(null);
  const [lastBatchApplied, setLastBatchApplied] = useState(false);
  const [rowConfirmation, setRowConfirmation] = useState<{ count: number; onConfirm: () => void } | null>(
    null,
  );
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const prevRowIdsRef = useRef<string[]>(visibleRowIds);
  const prevColIdsRef = useRef<string[]>(visibleColIds);
  const tdRefs = useRef<Map<string, HTMLTableCellElement>>(new Map());
  const fillCopyButtonRef = useRef<HTMLButtonElement>(null);
  const isSelectingRef = useRef<boolean>(false);
  const fillDraggingRef = useRef<boolean>(false);
  const fillSourceRangeRef = useRef<GridRange | null>(null);
  const hasFillPreview = fillPreview !== null;

  useEffect(() => {
    if (!hasFillPreview || !focusFillActions) return;
    const frame = window.requestAnimationFrame(() => {
      fillCopyButtonRef.current?.focus({ preventScroll: true });
      setFocusFillActions(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hasFillPreview, focusFillActions]);

  // Active cell revalidation upon sort, filter, or column hide
  useEffect(() => {
    const prevRows = prevRowIdsRef.current;
    const prevCols = prevColIdsRef.current;
    const rowsChanged = prevRows !== visibleRowIds;
    const colsChanged = prevCols !== visibleColIds;
    prevRowIdsRef.current = visibleRowIds;
    prevColIdsRef.current = visibleColIds;
    if (!rowsChanged && !colsChanged) return;

    const currentActive = activeCellRef.current;
    let focusAfterRevalidation: GridCoord | null = null;
    if (currentActive) {
      const reval = revalidateActiveCell(currentActive, prevRows, prevCols, visibleRowIds, visibleColIds);
      if (reval.moved) {
        setActiveCell(reval.active);
        focusAfterRevalidation = reval.active;
        setLiveAnnouncement(t('database.activeCellMoved', { reason: reval.reason ?? '' }));
      }
    } else if (visibleRowIds.length > 0 && visibleColIds.length > 0) {
      const r = visibleRowIds[0];
      const c = visibleColIds[0];
      if (r && c) {
        const initial = { rowId: r, colId: c };
        setActiveCell(initial);
        focusAfterRevalidation = initial;
      }
    }

    if (selectionRange) {
      const anchorResult = revalidateActiveCell(
        selectionRange.anchor,
        prevRows,
        prevCols,
        visibleRowIds,
        visibleColIds,
      );
      const focusResult = revalidateActiveCell(
        selectionRange.focus,
        prevRows,
        prevCols,
        visibleRowIds,
        visibleColIds,
      );
      if (anchorResult.moved || focusResult.moved) {
        const fallback = focusResult.active ?? anchorResult.active ?? focusAfterRevalidation;
        const anchor = anchorResult.active ?? fallback;
        const focus = focusResult.active ?? fallback;
        if (anchor && focus) setSelectionRange({ anchor, focus });
        else setSelectionRange(null);
        focusAfterRevalidation = focus ?? focusAfterRevalidation;
        if (
          !currentActive ||
          !revalidateActiveCell(currentActive, prevRows, prevCols, visibleRowIds, visibleColIds).moved
        ) {
          setLiveAnnouncement(t('database.rangeSelectionAdjusted'));
        }
      } else if (focusAfterRevalidation) {
        setSelectionRange({ anchor: focusAfterRevalidation, focus: focusAfterRevalidation });
      }
    } else if (focusAfterRevalidation) {
      setSelectionRange({ anchor: focusAfterRevalidation, focus: focusAfterRevalidation });
    }
    if (focusAfterRevalidation) {
      tdRefs.current
        .get(`${focusAfterRevalidation.rowId}:${focusAfterRevalidation.colId}`)
        ?.focus({ preventScroll: true });
    }
    setFillPreview(null);
    setFocusFillActions(false);
    fillSourceRangeRef.current = null;
  }, [visibleRowIds, visibleColIds, selectionRange]);

  const resolvedSelection = useMemo(
    () => (selectionRange ? resolveVisibleRange(selectionRange, visibleRowIds, visibleColIds) : null),
    [selectionRange, visibleRowIds, visibleColIds],
  );

  const navigateCell = (
    direction: 'up' | 'down' | 'left' | 'right' | 'next' | 'prev',
    extendSelection = false,
  ) => {
    if (!activeCell || visibleRowIds.length === 0 || visibleColIds.length === 0) return;
    if (fillPreview) cancelFillPreview();
    const baseCoord = extendSelection && selectionRange ? selectionRange.focus : activeCell;
    const rIdx = visibleRowIds.indexOf(baseCoord.rowId);
    const cIdx = visibleColIds.indexOf(baseCoord.colId);
    if (rIdx === -1 || cIdx === -1) return;

    let nextR = rIdx;
    let nextC = cIdx;

    if (direction === 'up') nextR = Math.max(0, rIdx - 1);
    else if (direction === 'down') nextR = Math.min(visibleRowIds.length - 1, rIdx + 1);
    else if (direction === 'left') nextC = Math.max(0, cIdx - 1);
    else if (direction === 'right') nextC = Math.min(visibleColIds.length - 1, cIdx + 1);
    else if (direction === 'next') {
      if (cIdx + 1 < visibleColIds.length) {
        nextC = cIdx + 1;
      } else if (rIdx + 1 < visibleRowIds.length) {
        nextR = rIdx + 1;
        nextC = 0;
      }
    } else if (direction === 'prev') {
      if (cIdx > 0) {
        nextC = cIdx - 1;
      } else if (rIdx > 0) {
        nextR = rIdx - 1;
        nextC = visibleColIds.length - 1;
      }
    }

    const nr = visibleRowIds[nextR];
    const nc = visibleColIds[nextC];
    if (!nr || !nc) return;
    const nextCoord: GridCoord = { rowId: nr, colId: nc };

    if (extendSelection && selectionRange) {
      setSelectionRange({ anchor: selectionRange.anchor, focus: nextCoord });
    } else {
      setActiveCell(nextCoord);
      setSelectionRange({ anchor: nextCoord, focus: nextCoord });
    }

    const cellKey = `${nextCoord.rowId}:${nextCoord.colId}`;
    tdRefs.current.get(cellKey)?.focus();
  };

  const handleCommitAndMove = (
    rowId: PageId,
    colId: string,
    direction: 'down' | 'up' | 'next' | 'prev' | 'stay',
  ) => {
    invalidEditingCellRef.current = null;
    setEditingCell(null);
    if (direction === 'stay') {
      const cellKey = `${rowId}:${colId}`;
      tdRefs.current.get(cellKey)?.focus();
      return;
    }
    navigateCell(direction, false);
  };

  const handleCancelEdit = (rowId: PageId, colId: string) => {
    invalidEditingCellRef.current = null;
    setEditingCell(null);
    tdRefs.current.get(`${rowId}:${colId}`)?.focus({ preventScroll: true });
  };

  const handleDoneEdit = () => {
    invalidEditingCellRef.current = null;
    setEditingCell(null);
  };

  const applyBatchPlan = (
    plan: GridOperationPlan,
    successKey: 'database.clearBatchSuccess' | 'database.pasteBatchSuccess',
  ) => {
    if (!canEditImmediately()) {
      toast(t('database.unsupportedSchema'), { tone: 'error' });
      return false;
    }
    const result = runAll(plan.commands);
    if (!result.ok) {
      toast(result.error, { tone: 'error' });
      return false;
    }
    setLastBatchUndo(plan.undoCommands);
    setLastBatchRedo(plan.redoCommands);
    setLastBatchApplied(true);
    toast(t(successKey, { count: plan.affectedCells }), {
      action: {
        label: t('toasts.undo'),
        run: () => {
          if (!canEditImmediately()) return;
          const undone = runAll(plan.undoCommands);
          if (!undone.ok) {
            toast(undone.error, { tone: 'error' });
            return;
          }
          setLastBatchApplied(false);
        },
      },
    });
    return true;
  };

  const handleBatchClear = () => {
    if (!canEditImmediately()) {
      toast(t('database.unsupportedSchema'), { tone: 'error' });
      return;
    }
    if (!selectionRange) return;
    const planResult = planGridClear(
      state,
      dbId,
      selectionRange,
      visibleRowIds,
      visibleColIds,
      nowTimestamp(),
    );
    if (!planResult.ok) {
      toast(planResult.error, { tone: 'error' });
      return;
    }
    applyBatchPlan(planResult.value, 'database.clearBatchSuccess');
  };

  const handleBatchCopy = async () => {
    if (!selectionRange) return;
    const serialized = serializeGridClipboard(state, dbId, selectionRange, visibleRowIds, visibleColIds);
    if (!serialized.ok) {
      toast(serialized.error, { tone: 'error' });
      return;
    }
    try {
      await writeGridClipboard(serialized.value.tsv, serialized.value.payload);
    } catch {
      toast(t('database.clipboardWriteFailed'), { tone: 'error' });
    }
  };

  const handleBatchPaste = async () => {
    if (!canEditImmediately()) {
      toast(t('database.unsupportedSchema'), { tone: 'error' });
      return;
    }
    if (!activeCell || !selectionRange) return;
    let clipboardContents: Awaited<ReturnType<typeof readGridClipboard>>;
    try {
      clipboardContents = await readGridClipboard();
    } catch {
      toast(t('database.clipboardReadFailed'), { tone: 'error' });
      return;
    }
    if (!clipboardContents.text && !clipboardContents.hasGridPayload) return;

    let payload: GridClipboardPayload;
    if (clipboardContents.hasGridPayload) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(clipboardContents.gridPayloadJson ?? '');
      } catch {
        toast(t('database.clipboardReadFailed'), { tone: 'error' });
        return;
      }
      const validated = validateGridClipboardEnvelope(envelope, clipboardContents.text);
      if (!validated.ok) {
        toast(t('database.clipboardReadFailed'), { tone: 'error' });
        return;
      }
      payload = validated.value;
    } else {
      const parsed = parseGridClipboard(clipboardContents.text);
      if (!parsed.ok) {
        toast(parsed.error, { tone: 'error' });
        return;
      }
      payload = parsed.value;
    }

    const planResult = planGridPaste(
      state,
      dbId,
      selectionRange,
      payload,
      visibleRowIds,
      visibleColIds,
      nowTimestamp(),
      {
        allowCreateRows: false,
      },
    );

    if (!planResult.ok) {
      if (planResult.extraRowsNeeded) {
        const needed = planResult.extraRowsNeeded;
        setRowConfirmation({
          count: needed,
          onConfirm: () => {
            setRowConfirmation(null);
            const authResult = planGridPaste(
              state,
              dbId,
              selectionRange,
              payload!,
              visibleRowIds,
              visibleColIds,
              nowTimestamp(),
              {
                allowCreateRows: true,
                newRowIdFactory: () => newId(),
              },
            );
            if (authResult.ok) {
              applyBatchPlan(authResult.value, 'database.pasteBatchSuccess');
            } else {
              toast(authResult.error, { tone: 'error' });
            }
          },
        });
        return;
      }
      toast(planResult.error, { tone: 'error' });
      return;
    }

    applyBatchPlan(planResult.value, 'database.pasteBatchSuccess');
  };

  const updateFillPreview = useCallback(
    (sourceRange: GridRange, targetRange: GridRange, mode: FillModeChoice) => {
      if (!editable) return;
      const plan = planGridFill(
        state,
        dbId,
        sourceRange,
        targetRange,
        mode,
        visibleRowIds,
        visibleColIds,
        nowTimestamp(),
        { prepareUndo: false },
      );
      if (!plan.ok) {
        setFillPreview({
          sourceRange,
          targetRange,
          mode,
          previewCells: [],
          commands: [],
          undoCommands: [],
          redoCommands: [],
          affectedCells: 0,
          canSequence: false,
          error: plan.error,
        });
        return;
      }
      setFillPreview({
        sourceRange,
        targetRange,
        mode,
        previewCells: plan.value.previewCells,
        commands: plan.value.commands,
        undoCommands: plan.value.undoCommands,
        redoCommands: plan.value.redoCommands,
        affectedCells: plan.value.affectedCells,
        canSequence: plan.value.canSequence,
      });
    },
    [dbId, editable, state, visibleColIds, visibleRowIds],
  );

  const beginKeyboardFill = (direction: 'up' | 'down' | 'left' | 'right') => {
    if (!editable) {
      toast(t('database.unsupportedSchema'), { tone: 'error' });
      return;
    }
    const sourceRange = selectionRange ?? (activeCell ? { anchor: activeCell, focus: activeCell } : null);
    if (!sourceRange) return;
    const resolved = resolveVisibleRange(sourceRange, visibleRowIds, visibleColIds);
    if (!resolved) {
      toast(t('database.rangeSelectionAdjusted'), { tone: 'error' });
      return;
    }
    const firstRow = visibleRowIds[0];
    const lastRow = visibleRowIds[visibleRowIds.length - 1];
    const firstCol = visibleColIds[0];
    const lastCol = visibleColIds[visibleColIds.length - 1];
    const focus =
      direction === 'up'
        ? { rowId: firstRow!, colId: sourceRange.focus.colId }
        : direction === 'down'
          ? { rowId: lastRow!, colId: sourceRange.focus.colId }
          : direction === 'left'
            ? { rowId: sourceRange.focus.rowId, colId: firstCol! }
            : { rowId: sourceRange.focus.rowId, colId: lastCol! };
    const targetRange: GridRange = { anchor: sourceRange.anchor, focus };
    fillSourceRangeRef.current = sourceRange;
    fillDraggingRef.current = false;
    setFocusFillActions(true);
    updateFillPreview(sourceRange, targetRange, 'copy');
  };

  const applyFillPreview = () => {
    if (!editable) {
      toast(t('database.unsupportedSchema'), { tone: 'error' });
      return;
    }
    if (!fillPreview || fillPreview.error || fillPreview.commands.length === 0) return;
    const plan = planGridFill(
      state,
      dbId,
      fillPreview.sourceRange,
      fillPreview.targetRange,
      fillPreview.mode,
      visibleRowIds,
      visibleColIds,
      nowTimestamp(),
    );
    if (!plan.ok) {
      setFillPreview({ ...fillPreview, error: plan.error });
      toast(plan.error, { tone: 'error' });
      return;
    }
    if (applyBatchPlan(plan.value, 'database.pasteBatchSuccess')) {
      setActiveCell(fillPreview.targetRange.focus);
      setSelectionRange(fillPreview.targetRange);
      setFillPreview(null);
      setFocusFillActions(false);
      fillSourceRangeRef.current = null;
      tdRefs.current
        .get(`${fillPreview.targetRange.focus.rowId}:${fillPreview.targetRange.focus.colId}`)
        ?.focus();
    }
  };

  const cancelFillPreview = (restoreFocus = false) => {
    const returnTo = fillPreview?.sourceRange.focus ?? fillSourceRangeRef.current?.focus;
    setFillPreview(null);
    setFocusFillActions(false);
    fillSourceRangeRef.current = null;
    fillDraggingRef.current = false;
    if (restoreFocus && returnTo) {
      window.requestAnimationFrame(() =>
        tdRefs.current.get(`${returnTo.rowId}:${returnTo.colId}`)?.focus({ preventScroll: true }),
      );
    }
  };

  const handleCellMouseEnter = useCallback(
    (rowId: PageId, colId: string) => {
      if (fillDraggingRef.current && fillSourceRangeRef.current) {
        const targetRange: GridRange = {
          anchor: fillSourceRangeRef.current.anchor,
          focus: { rowId, colId },
        };
        updateFillPreview(fillSourceRangeRef.current, targetRange, 'copy');
        return;
      }

      if (isSelectingRef.current && selectionRange) {
        setSelectionRange({ anchor: selectionRange.anchor, focus: { rowId, colId } });
      }
    },
    [selectionRange, updateFillPreview],
  );

  useEffect(() => {
    const onGlobalMouseMove = (e: MouseEvent) => {
      if (!fillDraggingRef.current && !isSelectingRef.current) return;
      const td = (
        document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      )?.closest<HTMLTableCellElement>('td[data-row-id]');
      if (td) {
        const rowId = td.getAttribute('data-row-id');
        const colId = td.getAttribute('data-col-id');
        if (rowId && colId) {
          handleCellMouseEnter(rowId, colId);
        }
      }
    };

    const onGlobalMouseUp = () => {
      if (isSelectingRef.current) {
        isSelectingRef.current = false;
      }
      if (fillDraggingRef.current) {
        fillDraggingRef.current = false;
        setFocusFillActions(true);
      }
    };

    const onGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const returnTo = fillSourceRangeRef.current?.focus;
        fillDraggingRef.current = false;
        setFillPreview(null);
        setFocusFillActions(false);
        fillSourceRangeRef.current = null;
        if (returnTo) {
          window.requestAnimationFrame(() =>
            tdRefs.current.get(`${returnTo.rowId}:${returnTo.colId}`)?.focus({ preventScroll: true }),
          );
        }
      }
    };

    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
    window.addEventListener('keydown', onGlobalKeyDown);
    return () => {
      window.removeEventListener('mousemove', onGlobalMouseMove);
      window.removeEventListener('mouseup', onGlobalMouseUp);
      window.removeEventListener('keydown', onGlobalKeyDown);
    };
  }, [state, dbId, visibleRowIds, visibleColIds, selectionRange, handleCellMouseEnter]);

  const handleCellKeyDown = (
    event: React.KeyboardEvent<HTMLTableCellElement>,
    rowId: PageId,
    colId: string,
  ) => {
    if (event.defaultPrevented || editingCell) return;
    const startKey = cellEditStartKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      altGraph: event.getModifierState('AltGraph'),
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    });
    const cellProp = database.properties.find((candidate) => candidate.id === colId);
    const editableColumn =
      canEditImmediately() &&
      !isColumnReadOnly(colId, database) &&
      !['image', 'file', 'richCanvas'].includes(cellProp?.type ?? '');
    if (startKey.kind === 'composition') {
      if (editableColumn) {
        invalidEditingCellRef.current = null;
        setEditingCell({ rowId, colId, ...cellPickerStartProps(cellProp?.type, startKey) });
      }
      return;
    }

    if (event.altKey && event.shiftKey && event.key === 'ArrowDown') {
      event.preventDefault();
      beginKeyboardFill('down');
    } else if (event.altKey && event.shiftKey && event.key === 'ArrowUp') {
      event.preventDefault();
      beginKeyboardFill('up');
    } else if (event.altKey && event.shiftKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      beginKeyboardFill('left');
    } else if (event.altKey && event.shiftKey && event.key === 'ArrowRight') {
      event.preventDefault();
      beginKeyboardFill('right');
    } else if (event.altKey && event.key === 'Enter') {
      if (colId === TITLE_PROP) {
        event.preventDefault();
        openPage(rowId);
      }
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      navigateCell('up', event.shiftKey);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      navigateCell('down', event.shiftKey);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      navigateCell('left', event.shiftKey);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      navigateCell('right', event.shiftKey);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      navigateCell(event.shiftKey ? 'prev' : 'next', false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      navigateCell(event.shiftKey ? 'up' : 'down', false);
    } else if (event.key === 'F2') {
      event.preventDefault();
      if (editableColumn) {
        invalidEditingCellRef.current = null;
        setEditingCell({ rowId, colId });
      }
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleBatchClear();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      handleBatchCopy();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      handleBatchPaste();
    } else if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      ['z', 'y'].includes(event.key.toLowerCase())
    ) {
      const isRedo = event.key.toLowerCase() === 'y' || event.shiftKey;
      if (!canEditImmediately()) {
        event.preventDefault();
        toast(t('database.unsupportedSchema'), { tone: 'error' });
        return;
      }
      if (isRedo && !lastBatchApplied && lastBatchRedo) {
        event.preventDefault();
        const result = runAll(lastBatchRedo);
        if (result.ok) {
          setLastBatchApplied(true);
        } else toast(result.error, { tone: 'error' });
      } else if (!isRedo && lastBatchApplied && lastBatchUndo) {
        event.preventDefault();
        const result = runAll(lastBatchUndo);
        if (result.ok) {
          setLastBatchApplied(false);
        } else toast(result.error, { tone: 'error' });
      }
    } else if (startKey.kind === 'text' && editableColumn) {
      const prop = cellProp;
      const isTextEditor =
        colId === TITLE_PROP || ['text', 'email', 'url', 'phone'].includes(prop?.type ?? '');
      const isNumberEditor = ['number', 'currency', 'percent', 'duration', 'progress'].includes(prop?.type ?? '');
      if (isNumberEditor && !/^[0-9.,+-]$/.test(startKey.text)) return;
      event.preventDefault();
      const initialText = startKey.text;
      const pickerStartProps = cellPickerStartProps(prop?.type, startKey);
      const initialValidationValue =
        prop && isNumberEditor
          ? (() => {
              const multiplier =
                prop.type === 'percent'
                  ? 100
                  : prop.type === 'duration'
                    ? 1 / durationUnitFactor(prop.format?.durationUnit ?? 'minutes')
                    : 1;
              const number = Number(initialText);
              return initialText.trim() && Number.isFinite(number)
                ? number / multiplier
                : initialText.trim()
                  ? Number.NaN
                  : null;
            })()
          : prop && ['email', 'url', 'phone'].includes(prop.type)
            ? initialText.trim() || null
            : null;
      const hasInitialValidation =
        Boolean(prop && (isNumberEditor || ['email', 'url', 'phone'].includes(prop.type)));
      invalidEditingCellRef.current =
        hasInitialValidation && prop && scalarValueError(prop, initialValidationValue)
          ? `${rowId}:${colId}`
          : null;
      setEditingCell({
        rowId,
        colId,
        ...(isTextEditor || isNumberEditor ? { initialText } : {}),
        ...pickerStartProps,
      });
    }
  };

  const handleCellMouseDown = (rowId: PageId, colId: string, event: React.MouseEvent) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.db-fill-handle')) return;
    if (invalidEditingCellRef.current) {
      event.preventDefault();
      return;
    }
    if (editingCell?.rowId === rowId && editingCell?.colId === colId) return;

    clearRowSelection();
    isSelectingRef.current = true;
    const coord: GridCoord = { rowId, colId };
    setActiveCell(coord);
    setSelectionRange({ anchor: coord, focus: coord });
    cancelFillPreview();
  };

  const handleCellDoubleClick = (rowId: PageId, colId: string) => {
    if (invalidEditingCellRef.current) return;
    clearRowSelection();
    const prop = database.properties.find((candidate) => candidate.id === colId);
    if (
      editable &&
      !isColumnReadOnly(colId, database) &&
      !['image', 'file', 'richCanvas'].includes(prop?.type ?? '')
    ) {
      invalidEditingCellRef.current = null;
      setEditingCell({ rowId, colId });
    }
  };

  const isBottomRightCell = (rowId: PageId, colId: string) => {
    if (!resolvedSelection) return false;
    return (
      resolvedSelection.rowIds[resolvedSelection.rowIds.length - 1] === rowId &&
      resolvedSelection.colIds[resolvedSelection.colIds.length - 1] === colId
    );
  };
  const [summaryAnchor, setSummaryAnchor] = useState<{ propId: string; anchor: HTMLElement } | null>(null);
  const [header, setHeader] = useState<{
    prop: PropDef;
    anchor: HTMLElement;
    focusSection?: 'formula';
  } | null>(null);
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
    ROW_CONTROLS_WIDTH * (editable ? 1 : 0) +
    widthOf(TITLE_PROP) +
    props.reduce((sum, prop) => sum + widthOf(prop.id), 0) +
    (editable ? 36 : 0);
  const frozenIndex = props.findIndex((prop) => prop.id === view.frozenThrough);
  const frozenStyle = (index: number): CSSProperties | undefined => {
    if (frozenIndex < 0 || index > frozenIndex) return undefined;
    const left =
      ROW_CONTROLS_WIDTH * (editable ? 1 : 0) +
      (index < 0
        ? 0
        : widthOf(TITLE_PROP) + props.slice(0, index).reduce((sum, prop) => sum + widthOf(prop.id), 0));
    return { position: 'sticky', left, zIndex: 2 };
  };
  const fitColumn = (propId: string) => {
    const table = tableRef.current;
    const index = props.findIndex((prop) => prop.id === propId) + 1 + (editable ? 1 : 0);
    if (!table || index < 1) return;
    const probe = document.createElement('span');
    probe.style.position = 'fixed';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'nowrap';
    document.body.appendChild(probe);
    let widest = 0;
    for (const row of Array.from(table.rows)) {
      const cell = row.cells.item(index);
      if (!cell) continue;
      const style = getComputedStyle(cell);
      probe.style.font = style.font;
      probe.style.letterSpacing = style.letterSpacing;
      probe.textContent = cell.innerText;
      widest = Math.max(widest, probe.getBoundingClientRect().width);
    }
    probe.remove();
    saveWidth(propId, Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest + 48))));
  };
  const selectedSort = columnMenu ? view.sorts.find((item) => item.prop === columnMenu.prop.id) : undefined;
  const openColumnMenu = (prop: PropDef, anchor: HTMLElement) => {
    setHeader(null);
    setInserting(null);
    setColumnMenu({ prop, anchor });
  };
  const duplicateColumn = (propId: string, includeValues: boolean) => {
    const plan = planColumnDuplicate(
      state,
      dbId,
      propId,
      newId(),
      includeValues,
      nowTimestamp(),
      t('database.copySuffix'),
    );
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
          const undo = planColumnDuplicateUndo(getState(), dbId, plan.property.id, snapshot, nowTimestamp());
          if (!undo) {
            toast(t('database.duplicateColumnUndoUnavailable'), { tone: 'error' });
            return;
          }
          runAll(undo);
        },
      },
    });
  };
  const rowTargets = Object.values(state.pages).filter(
    (page) =>
      page.kind === 'database' &&
      page.database &&
      page.trashedAt === null &&
      !page.database.unsupportedProperties?.length,
  );
  const siblings = childrenOf(state.pages, dbId);
  const canReorderRows =
    editable &&
    view.sorts.length === 0 &&
    view.filters.length === 0 &&
    view.groupBy === null &&
    visibleRowIds.length === siblings.length &&
    visibleRowIds.every((id) => siblings.some((row) => row.id === id));
  const rowReorderHint =
    view.sorts.length > 0 ? t('database.rowReorderSortHint') : t('database.rowReorderFilterHint');
  const mappingDestination = rowMappingDialog ? state.pages[rowMappingDialog.destinationDatabaseId] : null;
  const rowMappingPreview =
    rowMappingDialog && mappingDestination?.kind === 'database' && mappingDestination.database
      ? previewRowMappings(
          rowMappingDialog.payload.sourceProperties,
          mappingDestination.database,
          rowMappingDialog.payload.rows,
          rowMappingDialog.mappings,
        )
      : [];
  useEffect(() => {
    if (headerRowSelectorRef.current)
      headerRowSelectorRef.current.indeterminate =
        selectedVisibleRowIds.length > 0 && selectedVisibleRowIds.length < visibleRowIds.length;
  }, [selectedVisibleRowIds.length, visibleRowIds.length]);
  const rowActionIds = (rowId: PageId) =>
    selectedVisibleRowIds.includes(rowId) ? selectedVisibleRowIds : [rowId];
  const applyRowPlan = async (plan: RowOperationPlan, label: string, successMessage: string) => {
    const result = await executeTableAction(getSession(), asTableActionPlan(plan, label), nowTimestamp());
    window.dispatchEvent(new Event('morrow-table-action-changed'));
    if (result.status === 'saved') toast(successMessage);
    else toast(result.message, { tone: result.status === 'pending' ? 'info' : 'error' });
    return result.status === 'saved';
  };
  const insertRowAt = (rowId: PageId, placement: 'before' | 'after') => {
    const planned = planInsertRow(getState(), dbId, rowId, placement, newId(), nowTimestamp());
    if (!planned.ok) {
      toast(planned.error, { tone: 'error' });
      return;
    }
    void applyRowPlan(
      planned.value,
      placement === 'before' ? t('database.rowInsertBefore') : t('database.rowInsertAfter'),
      t('database.rowInsertSuccess'),
    );
  };
  const duplicateRows = (rowIds: PageId[]) => {
    const planned = planDuplicateRows(state, dbId, rowIds, newId, nowTimestamp(), t('database.copySuffix'));
    if (!planned.ok) {
      toast(planned.error, { tone: 'error' });
      return;
    }
    void applyRowPlan(planned.value, t('database.rowDuplicate'), t('database.rowCopySuccess'));
  };
  const requestTrashRows = (rowIds: PageId[]) => {
    captureRowDialogFocus();
    const nested = new Set<PageId>();
    for (const id of rowIds) for (const page of descendantsOf(state.pages, id)) nested.add(page.id);
    setRowTrashConfirmation({ rowIds: [...rowIds], nestedCount: nested.size });
  };
  const trashRows = () => {
    if (!rowTrashConfirmation) return;
    const planned = planTrashRows(getState(), dbId, rowTrashConfirmation.rowIds, nowTimestamp());
    if (!planned.ok) {
      toast(planned.error, { tone: 'error' });
      closeRowTrashConfirmation();
      return;
    }
    setRowTrashConfirmation(null);
    setSelectedRowIds((current) => current.filter((id) => !rowTrashConfirmation.rowIds.includes(id)));
    setRowSelectionAnchor(null);
    void applyRowPlan(planned.value, t('database.rowTrash'), t('database.rowTrashSuccess')).then(() =>
      restoreRowDialogFocus(),
    );
  };
  const copyRows = async (rowIds: PageId[]) => {
    const payload = createRowClipboardPayload(getState(), dbId, rowIds);
    if (!payload.ok) {
      toast(payload.error, { tone: 'error' });
      return;
    }
    const serialized = serializeRowClipboard(payload.value);
    if (!serialized.ok) {
      toast(serialized.error, { tone: 'error' });
      return;
    }
    try {
      await writeClipboardText(serialized.value);
      toast(t('database.rowClipboardCopied', { count: rowIds.length }));
    } catch {
      toast(t('database.rowClipboardCopyFailed'), { tone: 'error' });
    }
  };
  const openRowMapping = (
    mode: 'copy' | 'move',
    payload: RowClipboardPayload,
    sourceDatabaseId: PageId,
    rowIds: PageId[],
    preferredDestinationId: PageId,
    afterRowId: PageId | null = null,
  ) => {
    const candidates = rowTargets.filter((page) => mode !== 'move' || page.id !== sourceDatabaseId);
    const destination = candidates.find((page) => page.id === preferredDestinationId) ?? candidates[0];
    if (!destination?.database) {
      toast(t('database.rowDestinationUnavailable'), { tone: 'error' });
      return;
    }
    setRowMappingDialog({
      mode,
      payload,
      sourceDatabaseId,
      rowIds,
      destinationDatabaseId: destination.id,
      afterRowId,
      mappings: suggestRowPropertyMappings(
        payload.sourceProperties,
        destination.database,
        payload.rows,
        destination.id === sourceDatabaseId,
      ),
    });
  };
  const moveRowsToTable = (rowIds: PageId[]) => {
    captureRowDialogFocus();
    const payload = createRowClipboardPayload(getState(), dbId, rowIds);
    if (!payload.ok) {
      toast(payload.error, { tone: 'error' });
      return;
    }
    const firstDestination = rowTargets.find((page) => page.id !== dbId)?.id ?? '';
    openRowMapping('move', payload.value, dbId, rowIds, firstDestination);
  };
  const pasteRowsAfter = async (afterRowId: PageId) => {
    captureRowDialogFocus();
    try {
      const text = await readClipboardText();
      const parsed = parseRowClipboardText(text);
      if (!parsed.ok) {
        toast(parsed.error, { tone: 'error' });
        return;
      }
      openRowMapping(
        'copy',
        parsed.value,
        parsed.value.sourceDatabaseId,
        parsed.value.rows.map((row) => row.page.id),
        dbId,
        afterRowId,
      );
    } catch {
      toast(t('database.rowClipboardPasteFailed'), { tone: 'error' });
    }
  };
  const routeKeyboardPaste = async (afterRowId: PageId | null) => {
    captureRowDialogFocus();
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      if (activeCell && selectionRange) {
        void handleBatchPaste();
        return;
      }
      toast(t('database.rowClipboardUnavailable'), { tone: 'error' });
      return;
    }

    if (text.startsWith(ROW_CLIPBOARD_VERSION_MARKER)) {
      const parsed = parseRowClipboardText(text);
      if (!parsed.ok) {
        toast(parsed.error, { tone: 'error' });
        return;
      }
      openRowMapping(
        'copy',
        parsed.value,
        parsed.value.sourceDatabaseId,
        parsed.value.rows.map((row) => row.page.id),
        dbId,
        afterRowId,
      );
      return;
    }

    if (activeCell && selectionRange) void handleBatchPaste();
  };
  const handleRowClipboardShortcut = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      event.defaultPrevented ||
      !canEditImmediately() ||
      rowMappingDialog !== null ||
      rowTrashConfirmation !== null ||
      !(event.ctrlKey || event.metaKey) ||
      event.altKey
    )
      return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !event.currentTarget.contains(target)) return;
    const emptyTableTarget = target === event.currentTarget && visibleRowIds.length === 0;
    if (!target.closest('.db-table') && !emptyTableTarget) return;
    if (
      target.closest(
        'textarea, select, form, [contenteditable="true"], .db-row-dialog, [role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-floating-ui-portal], [data-radix-popper-content-wrapper]',
      )
    )
      return;
    if (target instanceof HTMLInputElement && target.type !== 'checkbox') return;
    const key = event.key.toLowerCase();
    if (key === 'c' && selectedVisibleRowIds.length > 0) {
      event.preventDefault();
      void copyRows(selectedVisibleRowIds);
    } else if (key === 'v') {
      event.preventDefault();
      const afterRowId = selectedVisibleRowIds.at(-1) ?? activeCellRef.current?.rowId ?? null;
      void routeKeyboardPaste(afterRowId);
    }
  };
  const submitRowMapping = () => {
    if (!rowMappingDialog) return;
    const latest = getState();
    const destination = latest.pages[rowMappingDialog.destinationDatabaseId];
    if (destination?.kind !== 'database' || !destination.database) {
      toast(t('database.rowDestinationUnavailable'), { tone: 'error' });
      return;
    }
    const preview = previewRowMappings(
      rowMappingDialog.payload.sourceProperties,
      destination.database,
      rowMappingDialog.payload.rows,
      rowMappingDialog.mappings,
    );
    const invalid = preview.find((item) => item.error);
    if (invalid?.error) {
      toast(invalid.error, { tone: 'error' });
      return;
    }
    const now = nowTimestamp();
    const planned =
      rowMappingDialog.mode === 'move'
        ? planMoveRows(
            latest,
            rowMappingDialog.sourceDatabaseId,
            rowMappingDialog.destinationDatabaseId,
            rowMappingDialog.rowIds,
            rowMappingDialog.mappings,
            now,
          )
        : planPasteRows(
            latest,
            rowMappingDialog.destinationDatabaseId,
            rowMappingDialog.payload,
            rowMappingDialog.mappings,
            newId,
            now,
            t('database.copySuffix'),
            rowMappingDialog.afterRowId,
          );
    if (!planned.ok) {
      toast(planned.error, { tone: 'error' });
      return;
    }
    const mode = rowMappingDialog.mode;
    setRowMappingDialog(null);
    void applyRowPlan(
      planned.value,
      mode === 'move' ? t('database.rowMoveTo') : t('database.rowPaste'),
      mode === 'move' ? t('database.rowMoveSuccess') : t('database.rowCopySuccess'),
    ).then(() => restoreRowDialogFocus());
  };
  const changeMappingDestination = (destinationId: PageId) => {
    if (!rowMappingDialog) return;
    const destination = rowTargets.find((page) => page.id === destinationId);
    if (!destination?.database) return;
    setRowMappingDialog((current) =>
      current
        ? {
            ...current,
            destinationDatabaseId: destinationId,
            afterRowId: null,
            mappings: suggestRowPropertyMappings(
              current.payload.sourceProperties,
              destination.database!,
              current.payload.rows,
              destinationId === current.sourceDatabaseId,
            ),
          }
        : current,
    );
  };
  const dropRowsOn = (event: React.DragEvent<HTMLTableRowElement>, anchorRowId: PageId) => {
    if (!canReorderRows || dragRowIds.current.length === 0) return;
    event.preventDefault();
    const rowRect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < rowRect.top + rowRect.height / 2 ? 'before' : 'after';
    const dragged = dragRowIds.current.filter((id) => visibleRowIdSet.has(id));
    dragRowIds.current = [];
    const planned = planReorderRows(getState(), dbId, dragged, anchorRowId, placement);
    if (!planned.ok) {
      toast(planned.error, { tone: 'error' });
      return;
    }
    void applyRowPlan(planned.value, t('database.rowReorder'), t('database.rowReorderSuccess'));
  };
  return (
    <div
      className="db-table-view"
      onKeyDownCapture={handleRowClipboardShortcut}
      tabIndex={editable && visibleRowIds.length === 0 ? 0 : undefined}
      role={editable && visibleRowIds.length === 0 ? 'group' : undefined}
      aria-label={editable && visibleRowIds.length === 0 ? t('database.rowPasteTarget') : undefined}
      aria-keyshortcuts={editable && visibleRowIds.length === 0 ? 'Control+V Meta+V' : undefined}
    >
      {(selectedVisibleRowIds.length > 0 || (editable && visibleRowIds.length > 0 && !canReorderRows)) && (
        <div className="db-row-operations">
          {selectedVisibleRowIds.length > 0 && (
            <>
              <span className="db-row-selection-count" role="status">
                {t('database.rowSelectionCount', { count: selectedVisibleRowIds.length })}
              </span>
              <button
                type="button"
                className="button small"
                onClick={() => void copyRows(selectedVisibleRowIds)}
              >
                <Copy size={13} /> {t('database.rowCopy')}
              </button>
              <button
                type="button"
                className="button small"
                disabled={rowTargets.length < 2}
                onClick={() => moveRowsToTable(selectedVisibleRowIds)}
              >
                <ArrowDownUp size={13} /> {t('database.rowMoveTo')}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => duplicateRows(selectedVisibleRowIds)}
              >
                <Copy size={13} /> {t('database.rowDuplicate')}
              </button>
              <button
                type="button"
                className="button small danger"
                onClick={() => requestTrashRows(selectedVisibleRowIds)}
              >
                <Trash2 size={13} /> {t('database.rowTrash')}
              </button>
              <button
                type="button"
                className="button small"
                onClick={() => {
                  setSelectedRowIds([]);
                  setRowSelectionAnchor(null);
                }}
              >
                {t('database.rowClearSelection')}
              </button>
            </>
          )}
          {editable && visibleRowIds.length > 0 && !canReorderRows && (
            <span className="db-row-reorder-hint" role="status">
              {rowReorderHint}
            </span>
          )}
        </div>
      )}
      <div className="db-table-wrap">
        <table
          ref={tableRef}
          tabIndex={-1}
          className={`db-table${editable ? ' is-filled' : ''}`}
          style={{ width: total }}
        >
          <colgroup>
            {editable && <col style={{ width: ROW_CONTROLS_WIDTH }} />}
            <col style={{ width: widthOf(TITLE_PROP) }} />
            {props.map((prop) => (
              <col key={prop.id} style={{ width: widthOf(prop.id) }} />
            ))}
            {/* the add column takes whatever room is left, so the others keep the width they were given */}
            {editable && <col />}
          </colgroup>
          <thead>
            <tr>
              {editable && (
                <th
                  scope="col"
                  className="db-row-controls db-row-controls-header"
                  style={{ position: 'sticky', left: 0, zIndex: 5 }}
                >
                  <input
                    ref={headerRowSelectorRef}
                    className="db-row-select"
                    type="checkbox"
                    aria-label={t('database.rowSelectAll', { count: visibleRowIds.length })}
                    checked={
                      visibleRowIds.length > 0 && selectedVisibleRowIds.length === visibleRowIds.length
                    }
                    disabled={visibleRowIds.length === 0}
                    onChange={(event) => {
                      const next = event.currentTarget.checked ? [...visibleRowIds] : [];
                      selectRowsExplicitly(next);
                      setRowSelectionAnchor(next[0] ?? null);
                    }}
                  />
                </th>
              )}
              <th
                scope="col"
                className={`db-col-title${frozenIndex === -1 ? '' : ' db-frozen'}`}
                style={frozenStyle(-1)}
              >
                {t('database.name')}
                {resizer(TITLE_PROP)}
              </th>
              {props.map((prop) => {
                const description = prop.description?.trim() ? prop.description : null;
                return (
                  <th
                    key={prop.id}
                    scope="col"
                    className={props.indexOf(prop) <= frozenIndex ? 'db-frozen' : undefined}
                    style={frozenStyle(props.indexOf(prop))}
                  >
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
                        <span
                          className="db-header-icon"
                          aria-hidden="true"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            marginRight: '6px',
                            opacity: 0.85,
                          }}
                        >
                          <PropertyGlyph prop={prop} />
                        </span>
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
              const rowFormat = resolveConditionalFormatForRow(row, view, database, state);
              const rowStyle = conditionalFormatStyle(rowFormat);
              const titleFormat = resolveConditionalFormatForCell(
                row,
                TITLE_PROP,
                view,
                database,
                state,
              );
              const isTitleActive = activeCell?.rowId === row.id && activeCell?.colId === TITLE_PROP;
              const isTitleSelected =
                resolvedSelection?.rowIds.includes(row.id) && resolvedSelection?.colIds.includes(TITLE_PROP);
              const titleFillCell = fillPreview?.previewCells.find(
                (p) => p.rowId === row.id && p.colId === TITLE_PROP,
              );
              const isTitleFill = Boolean(titleFillCell);

              return (
                <tr
                  key={row.id}
                  className={selectedRowIdSet.has(row.id) ? 'is-row-selected' : undefined}
                  style={rowStyle}
                  onDragOver={(event) => {
                    if (canReorderRows && dragRowIds.current.length > 0) event.preventDefault();
                  }}
                  onDrop={(event) => dropRowsOn(event, row.id)}
                >
                  {editable && (
                    <td
                      className="db-row-controls"
                      style={{ ...rowStyle, position: 'sticky', left: 0, zIndex: 3 }}
                    >
                      <div className="db-row-tools">
                        <input
                          ref={(element) => {
                            if (element) rowSelectorRefs.current.set(row.id, element);
                            else rowSelectorRefs.current.delete(row.id);
                          }}
                          className="db-row-select"
                          type="checkbox"
                          checked={selectedRowIdSet.has(row.id)}
                          aria-label={t('database.rowSelect', { name: displayTitle(row) })}
                          onChange={(event) => {
                            const native = event.nativeEvent as MouseEvent;
                            changeRowSelection(row.id, event.currentTarget.checked, {
                              shift: Boolean(native.shiftKey),
                              additive: Boolean(native.ctrlKey || native.metaKey),
                            });
                          }}
                          onKeyDown={(event) => handleRowSelectorKeyDown(event, row.id)}
                        />
                        <button
                          type="button"
                          className="db-row-drag"
                          draggable={canReorderRows}
                          aria-label={t('database.rowGrip', { name: displayTitle(row) })}
                          aria-pressed={selectedRowIdSet.has(row.id)}
                          aria-haspopup="menu"
                          aria-expanded={rowMenu?.rowId === row.id}
                          aria-keyshortcuts="Enter Space Shift+F10 ContextMenu"
                          title={
                            canReorderRows
                              ? t('database.rowDrag', { name: displayTitle(row) })
                              : rowReorderHint
                          }
                          onClick={(event) => {
                            const additive = event.ctrlKey || event.metaKey;
                            changeRowSelection(row.id, additive ? !selectedRowIdSet.has(row.id) : true, {
                              shift: event.shiftKey,
                              additive,
                            });
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setRowMenu({ rowId: row.id, anchor: event.currentTarget });
                          }}
                          onKeyDown={(event) => handleRowSelectorKeyDown(event, row.id)}
                          onDragStart={(event) => {
                            const ids = selectedRowIdSet.has(row.id) ? selectedVisibleRowIds : [row.id];
                            dragRowIds.current = ids.filter((id) => visibleRowIdSet.has(id));
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData(
                              'application/x-morrow-row-ids',
                              JSON.stringify(dragRowIds.current),
                            );
                          }}
                          onDragEnd={() => {
                            dragRowIds.current = [];
                          }}
                        >
                          <GripVertical size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="db-row-menu-trigger"
                          aria-label={t('database.rowMenu', { name: displayTitle(row) })}
                          aria-haspopup="menu"
                          aria-expanded={rowMenu?.rowId === row.id}
                          onClick={(event) => setRowMenu({ rowId: row.id, anchor: event.currentTarget })}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setRowMenu({ rowId: row.id, anchor: event.currentTarget });
                          }}
                        >
                          <MoreHorizontal size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  )}
                  <td
                    ref={(el) => {
                      if (el) tdRefs.current.set(`${row.id}:${TITLE_PROP}`, el);
                      else tdRefs.current.delete(`${row.id}:${TITLE_PROP}`);
                    }}
                    tabIndex={isTitleActive ? 0 : -1}
                    data-row-id={row.id}
                    data-col-id={TITLE_PROP}
                    data-fill-preview={isTitleFill ? String(titleFillCell?.value ?? '') : undefined}
                    className={`db-col-title${frozenIndex === -1 ? '' : ' db-frozen'}${isTitleActive ? ' is-grid-active' : ''}${isTitleSelected ? ' is-grid-selected' : ''}${isTitleFill ? ' is-fill-preview' : ''}`}
                    style={{
                      ...rowStyle,
                      ...conditionalFormatStyle(titleFormat),
                      ...frozenStyle(-1),
                    }}
                    onFocus={clearRowSelection}
                    onKeyDown={(e) => handleCellKeyDown(e, row.id, TITLE_PROP)}
                    onMouseDown={(e) => handleCellMouseDown(row.id, TITLE_PROP, e)}
                    onMouseEnter={() => handleCellMouseEnter(row.id, TITLE_PROP)}
                    onDoubleClick={() => handleCellDoubleClick(row.id, TITLE_PROP)}
                  >
                    {titleFillCell ? (
                      <span className="db-cell-content db-fill-preview-value">
                        {titleFillCell.value === null || titleFillCell.value === '' ? (
                          <span className="prop-empty">{t('page.untitled')}</span>
                        ) : (
                          String(titleFillCell.value)
                        )}
                      </span>
                    ) : (
                      <RowTitle
                        row={row}
                        editable={editable}
                        canEditNow={canEditNow}
                        autoFocus={focusNew === row.id}
                        gridMode={true}
                        isEditing={editingCell?.rowId === row.id && editingCell?.colId === TITLE_PROP}
                        initialText={
                          editingCell?.rowId === row.id && editingCell?.colId === TITLE_PROP
                            ? editingCell.initialText
                            : undefined
                        }
                        onCommitAndMove={(dir) => handleCommitAndMove(row.id, TITLE_PROP, dir)}
                        onCancelEdit={() => handleCancelEdit(row.id, TITLE_PROP)}
                        onDoneEdit={handleDoneEdit}
                        onInvalidDraftChange={(invalid) => {
                          const cellKey = `${row.id}:${TITLE_PROP}`;
                          if (invalid) invalidEditingCellRef.current = cellKey;
                          else if (invalidEditingCellRef.current === cellKey)
                            invalidEditingCellRef.current = null;
                        }}
                      />
                    )}
                    {isBottomRightCell(row.id, TITLE_PROP) &&
                      editable &&
                      !isColumnReadOnly(TITLE_PROP, database) && (
                        <div
                          className="db-fill-handle"
                          role="button"
                          aria-label={t('database.fillHandle')}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            event.preventDefault();
                            fillDraggingRef.current = true;
                            fillSourceRangeRef.current = selectionRange;
                          }}
                        />
                      )}
                  </td>
                  {props.map((prop) => {
                    const cellFormat = resolveConditionalFormatForCell(
                      row,
                      prop.id,
                      view,
                      database,
                      state,
                    );
                    const isCellActive = activeCell?.rowId === row.id && activeCell?.colId === prop.id;
                    const isCellSelected =
                      resolvedSelection?.rowIds.includes(row.id) &&
                      resolvedSelection?.colIds.includes(prop.id);
                    const propFillCell = fillPreview?.previewCells.find(
                      (p) => p.rowId === row.id && p.colId === prop.id,
                    );
                    const isCellFill = Boolean(propFillCell);

                    return (
                      <td
                        key={prop.id}
                        ref={(el) => {
                          if (el) tdRefs.current.set(`${row.id}:${prop.id}`, el);
                          else tdRefs.current.delete(`${row.id}:${prop.id}`);
                        }}
                        tabIndex={isCellActive ? 0 : -1}
                        data-row-id={row.id}
                        data-col-id={prop.id}
                        data-fill-preview={isCellFill ? String(propFillCell?.value ?? '') : undefined}
                        className={`${props.indexOf(prop) <= frozenIndex ? 'db-frozen ' : ''}${isCellActive ? 'is-grid-active ' : ''}${isCellSelected ? 'is-grid-selected ' : ''}${isCellFill ? 'is-fill-preview' : ''}`}
                        style={{
                          ...rowStyle,
                          ...conditionalFormatStyle(cellFormat),
                          textAlign: view.align?.[prop.id] ?? 'left',
                          whiteSpace: view.wrap?.includes(prop.id) ? 'normal' : 'nowrap',
                          ...frozenStyle(props.indexOf(prop)),
                        }}
                        onFocus={clearRowSelection}
                        onKeyDown={(e) => handleCellKeyDown(e, row.id, prop.id)}
                        onMouseDown={(e) => handleCellMouseDown(row.id, prop.id, e)}
                        onMouseEnter={() => handleCellMouseEnter(row.id, prop.id)}
                        onDoubleClick={() => handleCellDoubleClick(row.id, prop.id)}
                      >
                        {view.rowHeight ? (
                          <div
                            className={`db-cell-frame${expandedCell === `${row.id}:${prop.id}` ? ' is-expanded' : ''}`}
                            style={{
                              maxHeight: expandedCell === `${row.id}:${prop.id}` ? undefined : view.rowHeight,
                            }}
                          >
                            {propFillCell ? (
                              <span className="db-cell-content db-fill-preview-value">
                                {propFillCell.value === null ||
                                propFillCell.value === '' ||
                                (Array.isArray(propFillCell.value) && propFillCell.value.length === 0) ? (
                                  <span className="prop-empty">{t('database.empty')}</span>
                                ) : prop.type === 'checkbox' ? (
                                  <input
                                    type="checkbox"
                                    className="prop-checkbox"
                                    checked={propFillCell.value === true}
                                    disabled
                                    tabIndex={-1}
                                    aria-label={prop.name}
                                  />
                                ) : (
                                  <PropertyDisplay prop={prop} value={propFillCell.value} />
                                )}
                              </span>
                            ) : (
                              <PropertyInput
                                dbId={dbId}
                                prop={prop}
                                row={row}
                                editable={editable}
                                canEditNow={canEditNow}
                                gridMode={true}
                                isEditing={editingCell?.rowId === row.id && editingCell?.colId === prop.id}
                                initialText={
                                  editingCell?.rowId === row.id && editingCell?.colId === prop.id
                                    ? editingCell.initialText
                                    : undefined
                                }
                                openPickerOnEdit={
                                  editingCell?.rowId === row.id && editingCell?.colId === prop.id
                                    ? editingCell.openPickerOnEdit
                                    : undefined
                                }
                                onCommitAndMove={(dir) => handleCommitAndMove(row.id, prop.id, dir)}
                                onCancelEdit={() => handleCancelEdit(row.id, prop.id)}
                                onDoneEdit={handleDoneEdit}
                                onInvalidDraftChange={(invalid) => {
                                  const cellKey = `${row.id}:${prop.id}`;
                                  if (invalid) invalidEditingCellRef.current = cellKey;
                                  else if (invalidEditingCellRef.current === cellKey)
                                    invalidEditingCellRef.current = null;
                                }}
                              />
                            )}
                          </div>
                        ) : propFillCell ? (
                          <span className="db-cell-content db-fill-preview-value">
                            {propFillCell.value === null ||
                            propFillCell.value === '' ||
                            (Array.isArray(propFillCell.value) && propFillCell.value.length === 0) ? (
                              <span className="prop-empty">{t('database.empty')}</span>
                            ) : prop.type === 'checkbox' ? (
                              <input
                                type="checkbox"
                                className="prop-checkbox"
                                checked={propFillCell.value === true}
                                disabled
                                tabIndex={-1}
                                aria-label={prop.name}
                              />
                            ) : (
                              <PropertyDisplay prop={prop} value={propFillCell.value} />
                            )}
                          </span>
                        ) : (
                          <PropertyInput
                            dbId={dbId}
                            prop={prop}
                            row={row}
                            editable={editable}
                            canEditNow={canEditNow}
                            gridMode={true}
                            isEditing={editingCell?.rowId === row.id && editingCell?.colId === prop.id}
                            initialText={
                              editingCell?.rowId === row.id && editingCell?.colId === prop.id
                                ? editingCell.initialText
                                : undefined
                            }
                            openPickerOnEdit={
                              editingCell?.rowId === row.id && editingCell?.colId === prop.id
                                ? editingCell.openPickerOnEdit
                                : undefined
                            }
                            onCommitAndMove={(dir) => handleCommitAndMove(row.id, prop.id, dir)}
                            onCancelEdit={() => handleCancelEdit(row.id, prop.id)}
                            onDoneEdit={handleDoneEdit}
                            onInvalidDraftChange={(invalid) => {
                              const cellKey = `${row.id}:${prop.id}`;
                              if (invalid) invalidEditingCellRef.current = cellKey;
                              else if (invalidEditingCellRef.current === cellKey)
                                invalidEditingCellRef.current = null;
                            }}
                          />
                        )}
                        {view.rowHeight && view.wrap?.includes(prop.id) && (
                          <button
                            type="button"
                            className="db-cell-expand icon-button tiny"
                            aria-label={t('database.expandCell', { name: prop.name })}
                            aria-expanded={expandedCell === `${row.id}:${prop.id}`}
                            title={t('database.expandCell', { name: prop.name })}
                            onClick={() =>
                              setExpandedCell((current) =>
                                current === `${row.id}:${prop.id}` ? null : `${row.id}:${prop.id}`,
                              )
                            }
                          >
                            <Maximize2 size={12} />
                          </button>
                        )}
                        {isBottomRightCell(row.id, prop.id) &&
                          editable &&
                          !isColumnReadOnly(prop.id, database) && (
                            <div
                              className="db-fill-handle"
                              role="button"
                              aria-label={t('database.fillHandle')}
                              onMouseDown={(event) => {
                                event.stopPropagation();
                                event.preventDefault();
                                fillDraggingRef.current = true;
                                fillSourceRangeRef.current = selectionRange;
                              }}
                            />
                          )}
                      </td>
                    );
                  })}
                  {editable && <td style={rowStyle} />}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              {editable && <td className="db-row-controls db-footer-cell" />}
              <th
                scope="row"
                data-col-id={TITLE_PROP}
                className={`db-col-title db-footer-cell${frozenIndex === -1 ? '' : ' db-frozen'}`}
                style={frozenStyle(-1)}
              >
                {view.summaries?.['title'] ? (
                  <button
                    type="button"
                    className="db-footer-summary"
                    onClick={(event) => setSummaryAnchor({ propId: 'title', anchor: event.currentTarget })}
                    title={summaryLabel(view.summaries['title'])}
                  >
                    {(() => {
                      const s = summarizeProperty(
                        rows,
                        { id: 'title', name: t('database.name'), type: 'text', options: [] },
                        view.summaries['title'],
                        database,
                        state,
                      );
                      return s.error ? '!' : s.value === null ? '—' : String(s.value);
                    })()}
                  </button>
                ) : editable ? (
                  <button
                    type="button"
                    className="db-calc-trigger"
                    aria-label={t('database.calculateSummaryFor', { name: t('database.name') })}
                    title={t('database.calculateSummaryFor', { name: t('database.name') })}
                    onClick={(event) => setSummaryAnchor({ propId: 'title', anchor: event.currentTarget })}
                  >
                    {t('database.calculate')}
                  </button>
                ) : null}
              </th>
              {props.map((prop) => {
                const operation = view.summaries?.[prop.id];
                const cellIndex = props.indexOf(prop);
                return (
                  <td
                    key={prop.id}
                    data-col-id={prop.id}
                    className={`db-footer-cell${cellIndex <= frozenIndex ? ' db-frozen' : ''}`}
                    style={{
                      ...frozenStyle(cellIndex),
                      textAlign: view.align?.[prop.id] ?? 'left',
                    }}
                  >
                    {operation ? (
                      (() => {
                        const summary = summarizeProperty(rows, prop, operation, database, state);
                        const isCountOp = [
                          'count',
                          'countValues',
                          'countUnique',
                          'countEmpty',
                          'countNotEmpty',
                          'checked',
                          'unchecked',
                        ].includes(operation);
                        const isPercentOp = ['percentEmpty', 'percentNotEmpty', 'percentChecked'].includes(
                          operation,
                        );
                        const isDateRange =
                          operation === 'range' &&
                          (prop.type === 'date' ||
                            prop.type === 'datetime' ||
                            prop.type === 'createdTime' ||
                            prop.type === 'lastEditedTime');
                        const formatted = summary.error
                          ? t('database.summaryFormulaError', { error: summary.error })
                          : summary.value === null
                            ? '—'
                            : isCountOp
                              ? String(summary.value)
                              : isPercentOp
                                ? `${Math.round(summary.value as number)}%`
                                : isDateRange
                                  ? `${summary.value} ${t('database.days')}`
                                  : formatDisplayValue(prop, summary.value, getLocale());
                        return (
                          <button
                            type="button"
                            className={`db-footer-summary${summary.error ? ' has-error' : ''}`}
                            onClick={(event) =>
                              setSummaryAnchor({ propId: prop.id, anchor: event.currentTarget })
                            }
                            title={summary.error ?? summaryLabel(operation)}
                          >
                            {formatted}
                          </button>
                        );
                      })()
                    ) : editable ? (
                      <button
                        type="button"
                        className="db-calc-trigger"
                        aria-label={t('database.calculateSummaryFor', { name: prop.name })}
                        title={t('database.calculateSummaryFor', { name: prop.name })}
                        onClick={(event) =>
                          setSummaryAnchor({ propId: prop.id, anchor: event.currentTarget })
                        }
                      >
                        {t('database.calculate')}
                      </button>
                    ) : null}
                  </td>
                );
              })}
              {editable && <td />}
            </tr>
          </tfoot>
        </table>
        {fillPreview && (
          <div className="db-fill-toolbar" role="group" aria-label={t('database.fillActions')}>
            <span
              className={fillPreview.error ? 'db-fill-error' : 'db-fill-status'}
              role={fillPreview.error ? 'alert' : 'status'}
            >
              {fillPreview.error ?? t('database.fillPreview', { count: fillPreview.affectedCells })}
            </span>
            <div className="db-fill-actions">
              <button
                ref={fillCopyButtonRef}
                type="button"
                className="button small"
                aria-pressed={fillPreview.mode === 'copy'}
                disabled={!editable || Boolean(fillPreview.error)}
                onClick={() => updateFillPreview(fillPreview.sourceRange, fillPreview.targetRange, 'copy')}
              >
                {t('database.fillCopy')}
              </button>
              {fillPreview.canSequence && (
                <button
                  type="button"
                  className="button small"
                  aria-pressed={fillPreview.mode === 'sequence'}
                  disabled={!editable}
                  onClick={() =>
                    updateFillPreview(fillPreview.sourceRange, fillPreview.targetRange, 'sequence')
                  }
                >
                  {t('database.fillSequence')}
                </button>
              )}
              <button
                type="button"
                className="button small primary"
                disabled={!editable || Boolean(fillPreview.error) || fillPreview.commands.length === 0}
                onClick={applyFillPreview}
              >
                {t('database.fillApply')}
              </button>
              <button type="button" className="button small" onClick={() => cancelFillPreview(true)}>
                {t('common.cancel')}
              </button>
            </div>
            <small className="db-fill-hint">{t('database.fillKeyboardHint')}</small>
          </div>
        )}
        {summaryAnchor && (
          <Popover
            anchor={summaryAnchor.anchor}
            onClose={() => setSummaryAnchor(null)}
            label={t('database.calculate')}
          >
            <div className="db-options-menu">
              <button
                type="button"
                className="db-options-item"
                onClick={() => {
                  saveView((current) => {
                    const summaries = { ...current.summaries };
                    delete summaries[summaryAnchor.propId];
                    return { ...current, summaries };
                  });
                  setSummaryAnchor(null);
                }}
              >
                {t('database.summaryNone')}
              </button>
              {operationsForProp(
                summaryAnchor.propId === 'title'
                  ? undefined
                  : props.find((p) => p.id === summaryAnchor.propId),
              ).map((op) => (
                <button
                  key={op}
                  type="button"
                  className="db-options-item"
                  onClick={() => {
                    saveView((current) => ({
                      ...current,
                      summaries: { ...current.summaries, [summaryAnchor.propId]: op },
                    }));
                    setSummaryAnchor(null);
                  }}
                >
                  {summaryLabel(op)}
                </button>
              ))}
            </div>
          </Popover>
        )}
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
            focusSection={header.focusSection}
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
                label: t('database.editColumn'),
                icon: Settings2,
                onSelect: () => setHeader({ prop: columnMenu.prop, anchor: columnMenu.anchor }),
              },
              {
                label: t('database.setDisplayColumn'),
                icon: Eye,
                checked: database.displayPropertyId === columnMenu.prop.id,
                onSelect: () =>
                  updateDatabase(dbId, (current) => ({ ...current, displayPropertyId: columnMenu.prop.id })),
              },
              ...(database.displayPropertyId === columnMenu.prop.id
                ? [
                    {
                      label: t('database.useTitleForDisplay'),
                      icon: X,
                      onSelect: () =>
                        updateDatabase(dbId, (current) => ({ ...current, displayPropertyId: null })),
                    },
                  ]
                : []),
              {
                label: t('database.editColumnFormula'),
                icon: Calculator,
                disabled: ['button', 'createdTime', 'lastEditedTime', 'image', 'file', 'richCanvas'].includes(
                  columnMenu.prop.type,
                ),
                onSelect: () =>
                  setHeader({ prop: columnMenu.prop, anchor: columnMenu.anchor, focusSection: 'formula' }),
              },
              {
                label: t('database.formatColumnConditionally'),
                icon: Paintbrush,
                onSelect: () => onRequestFormat(columnMenu.prop.id),
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
                label: t('database.freezeThroughColumn'),
                icon: Columns3,
                checked: view.frozenThrough === columnMenu.prop.id,
                onSelect: () => saveView((current) => ({ ...current, frozenThrough: columnMenu.prop.id })),
              },
              ...(view.frozenThrough
                ? [
                    {
                      label: t('database.unfreezeColumns'),
                      icon: X,
                      onSelect: () => saveView((current) => ({ ...current, frozenThrough: undefined })),
                    },
                  ]
                : []),
              {
                label: t('database.fitColumnToContent'),
                icon: Maximize2,
                onSelect: () => fitColumn(columnMenu.prop.id),
              },
              { heading: t('database.rowHeight') },
              ...(
                [
                  [undefined, 'database.rowHeightAutomatic'],
                  [34, 'database.rowHeightCompact'],
                  [68, 'database.rowHeightMedium'],
                  [120, 'database.rowHeightTall'],
                ] as const
              ).map(([height, label]) => ({
                label: t(label),
                checked: view.rowHeight === height,
                onSelect: () => saveView((current) => ({ ...current, rowHeight: height })),
              })),
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
        {rowMenu && (
          <Menu
            anchor={rowMenu.anchor}
            label={t('database.rowMenu', {
              name: displayTitle(state.pages[rowMenu.rowId] ?? rows.find((row) => row.id === rowMenu.rowId)!),
            })}
            onClose={() => setRowMenu(null)}
            entries={[
              {
                heading: t('database.rowSelectionCount', { count: rowActionIds(rowMenu.rowId).length }),
              },
              {
                label: t('database.rowOpen'),
                icon: Maximize2,
                onSelect: () => openPage(rowMenu.rowId),
              },
              { separator: true },
              {
                label: t('database.rowInsertBefore'),
                icon: Plus,
                disabled: !editable,
                onSelect: () => insertRowAt(rowMenu.rowId, 'before'),
              },
              {
                label: t('database.rowInsertAfter'),
                icon: Plus,
                disabled: !editable,
                onSelect: () => insertRowAt(rowMenu.rowId, 'after'),
              },
              {
                label: t('database.rowDuplicate'),
                icon: Copy,
                disabled: !editable,
                onSelect: () => duplicateRows(rowActionIds(rowMenu.rowId)),
              },
              {
                label: t('database.rowCopy'),
                icon: Copy,
                disabled: !editable,
                onSelect: () => void copyRows(rowActionIds(rowMenu.rowId)),
              },
              {
                label: t('database.rowPaste'),
                icon: Plus,
                disabled: !editable,
                onSelect: () => void pasteRowsAfter(rowMenu.rowId),
              },
              {
                label: t('database.rowMoveTo'),
                icon: ArrowDownUp,
                disabled: !editable || rowTargets.length < 2,
                onSelect: () => moveRowsToTable(rowActionIds(rowMenu.rowId)),
              },
              { separator: true },
              {
                label: t('database.rowTrash'),
                icon: Trash2,
                danger: true,
                disabled: !editable,
                onSelect: () => requestTrashRows(rowActionIds(rowMenu.rowId)),
              },
            ]}
          />
        )}
        {rowMappingDialog && mappingDestination?.kind === 'database' && mappingDestination.database && (
          <Dialog
            title={t(
              rowMappingDialog.mode === 'move'
                ? 'database.rowMoveDialogTitle'
                : 'database.rowPasteDialogTitle',
              { count: rowMappingDialog.payload.rows.length },
            )}
            onClose={closeRowMappingDialog}
            size="large"
            className="db-row-dialog"
          >
            <p className="db-row-dialog-hint">{t('database.rowMappingHint')}</p>
            <label className="field">
              <span>{t('database.rowDestination')}</span>
              <select
                className="text-input small"
                data-autofocus
                value={rowMappingDialog.destinationDatabaseId}
                onChange={(event) => changeMappingDestination(event.target.value)}
              >
                {rowTargets
                  .filter(
                    (page) =>
                      rowMappingDialog.mode !== 'move' || page.id !== rowMappingDialog.sourceDatabaseId,
                  )
                  .map((page) => (
                    <option key={page.id} value={page.id}>
                      {displayTitle(page)}
                    </option>
                  ))}
              </select>
            </label>
            <div className="db-row-mapping-list">
              <div className="db-row-mapping-heading">
                <span>{t('database.rowMappingSource')}</span>
                <span>{t('database.rowMappingTarget')}</span>
              </div>
              {rowMappingPreview.map((item) => {
                const currentChoice = rowMappingDialog.mappings[item.source.id] ?? '';
                const conversionKey =
                  item.conversion === 'select-to-multiple'
                    ? 'database.rowMappingSelectToMultiple'
                    : item.conversion === 'multiple-to-select'
                      ? 'database.rowMappingMultipleToSelect'
                      : item.conversion === 'numeric'
                        ? 'database.rowMappingNumeric'
                        : item.conversion === 'preserve'
                          ? 'database.rowMappingPreserve'
                          : item.conversion === 'derived'
                            ? 'database.rowMappingDerived'
                            : 'database.rowMappingSame';
                return (
                  <div className="db-row-mapping-item" key={item.source.id}>
                    <div className="db-row-mapping-source">
                      <strong>{item.source.name}</strong>
                      <span>{t('database.rowMappingValues', { count: item.valueCount })}</span>
                      {item.destination?.defaultValue !== undefined &&
                        item.valueCount < rowMappingDialog.payload.rows.length && (
                          <span>
                            {t('database.rowMappingDefault', {
                              value: formatDisplayValue(
                                item.destination,
                                item.destination.defaultValue,
                                getLocale(),
                              ),
                            })}
                          </span>
                        )}
                    </div>
                    {item.conversion === 'derived' ? (
                      <div className="db-row-mapping-derived">{t('database.rowMappingDerived')}</div>
                    ) : (
                      <select
                        className="text-input small"
                        aria-label={t('database.rowMappingFor', { name: item.source.name })}
                        value={currentChoice}
                        onChange={(event) =>
                          setRowMappingDialog((current) =>
                            current
                              ? {
                                  ...current,
                                  mappings: { ...current.mappings, [item.source.id]: event.target.value },
                                }
                              : current,
                          )
                        }
                      >
                        <option value="">{t('database.rowDoNotMap')}</option>
                        <option value={PRESERVE_ROW_PROPERTY}>{t('database.rowKeepFrontmatter')}</option>
                        {mappingDestination
                          .database!.properties.filter(
                            (prop) => !isColumnReadOnly(prop.id, mappingDestination.database!),
                          )
                          .map((prop) => (
                            <option key={prop.id} value={prop.id}>
                              {prop.name}
                            </option>
                          ))}
                      </select>
                    )}
                    <div className={`db-row-mapping-status${item.error ? ' is-error' : ''}`}>
                      {item.error ?? t(conversionKey)}
                    </div>
                  </div>
                );
              })}
            </div>
            <footer className="db-row-dialog-actions">
              <button type="button" className="button small" onClick={closeRowMappingDialog}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="button small primary"
                disabled={rowMappingPreview.some((item) => Boolean(item.error))}
                onClick={submitRowMapping}
              >
                {t(rowMappingDialog.mode === 'move' ? 'database.rowMoveSubmit' : 'database.rowPasteSubmit')}
              </button>
            </footer>
          </Dialog>
        )}
        {rowTrashConfirmation && (
          <Dialog
            title={t('database.rowTrashConfirmTitle', { count: rowTrashConfirmation.rowIds.length })}
            onClose={closeRowTrashConfirmation}
            role="alertdialog"
            describedBy="db-row-trash-impact"
            size="small"
            className="db-row-dialog db-row-trash-dialog"
          >
            <p id="db-row-trash-impact">
              {t('database.rowTrashImpact', {
                count: rowTrashConfirmation.nestedCount,
              })}
            </p>
            <p>{t('database.rowTrashUndo')}</p>
            <div className="db-row-dialog-actions">
              <button
                type="button"
                className="button small"
                data-autofocus
                onClick={closeRowTrashConfirmation}
              >
                {t('common.cancel')}
              </button>
              <button type="button" className="button small danger" onClick={trashRows}>
                {t('common.confirm')}
              </button>
            </div>
          </Dialog>
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
        {rowConfirmation && (
          <div
            className="db-paste-confirm-banner"
            role="dialog"
            aria-label={t('database.confirmPasteExtraRows', { count: rowConfirmation.count })}
            style={{
              position: 'fixed',
              bottom: '24px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--surface, #1e293b)',
              border: '1px solid var(--border)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
              padding: '12px 18px',
              borderRadius: '8px',
              zIndex: 100,
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <span>{t('database.confirmPasteExtraRows', { count: rowConfirmation.count })}</span>
            <button type="button" className="button small primary" onClick={rowConfirmation.onConfirm}>
              {t('common.confirm')}
            </button>
            <button type="button" className="button small" onClick={() => setRowConfirmation(null)}>
              {t('common.cancel')}
            </button>
          </div>
        )}
        <div className="sr-only" aria-live="polite" role="status">
          {liveAnnouncement}
        </div>
      </div>
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
  const rowFormat = resolveConditionalFormatForRow(row, view, database, state);
  const rowStyle = conditionalFormatStyle(rowFormat);
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
      <span
        className="db-card-title"
        style={conditionalFormatStyle(resolveConditionalFormatForCell(row, TITLE_PROP, view, database, state))}
      >
        {row.icon && <PageGlyph icon={row.icon} className="db-card-icon" />}
        {displayTitle(row)}
      </span>
      <span className="db-card-props">
        {props.map((prop) => {
          const cellFormat = resolveConditionalFormatForCell(row, prop.id, view, database, state);
          return (
            <span key={prop.id} style={conditionalFormatStyle(cellFormat)}>
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
                  style={conditionalFormatStyle(
                    resolveConditionalFormatForCell(row, TITLE_PROP, view, database, state),
                  )}
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

function ListView({ rows, props, database, view }: {
  rows: PageMeta[];
  props: PropDef[];
  database: DatabaseDef;
  view: ViewDef;
}) {
  const state = useWorkspace();
  return (
    <ul className="link-list db-list">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="link-row"
            style={conditionalFormatStyle(resolveConditionalFormatForRow(row, view, database, state))}
            onClick={() => openPage(row.id)}
          >
            <span className="tree-icon">
              <PageIcon page={row} />
            </span>
            <span
              className="link-row-title"
              style={conditionalFormatStyle(resolveConditionalFormatForCell(row, TITLE_PROP, view, database, state))}
            >
              {displayTitle(row)}
            </span>
            <span className="db-card-props">
              {props.map((prop) => (
                <span
                  key={prop.id}
                  style={conditionalFormatStyle(resolveConditionalFormatForCell(row, prop.id, view, database, state))}
                >
                  <PropertyDisplay prop={prop} value={valueOf(row, prop.id, database, state)} />
                </span>
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
