import type {
  DataApiDiagnostic,
  DataApiErrorCode,
  DataApiRow,
  DataApiSnapshot,
} from '../../../../src/app/plugins/dataApi';
import type {
  LinkedViewApi,
  LinkedViewConfig,
  LinkedViewSnapshot,
} from '../../../../src/app/plugins/linkedViewApi';
import type { DatabaseProviderContext } from '../../../../src/app/plugins/providerApi';
import type { EvaluatedCell, ProviderProperty, ReadySnapshot } from './formulas';
import { evaluateCell } from './formulas';
import { mergePrioritizedColumnOrder, projectLinkedView, type PresentedProperty } from './linkedView';
import { providerMessages } from './locale';

const PROVIDER_ID = 'polaris-dados';

interface Draft {
  readonly rowId: string;
  readonly propertyId: string;
  readonly expectedRevision: string;
  rawValue: string;
  errorCode: DataApiErrorCode | null;
  errorDetail: string | null;
}

interface PendingFlush {
  readonly kind: 'cell' | 'history';
  readonly rowId?: string;
  readonly propertyId?: string;
  readonly value?: number;
  errorDetail: string | null;
}

interface Notice {
  readonly kind: 'status' | 'error';
  readonly message: string;
  readonly detail?: string;
}

interface FocusSnapshot {
  readonly inside: boolean;
  readonly key: string | null;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

interface LinkedViewDraft {
  readonly expectedRevision: string;
  title: string;
  columnOrder: string[];
  filterPropertyId: string;
  filterValue: string;
  filterTouched: boolean;
  stale: boolean;
  staged: boolean;
  errorDetail: string | null;
}

interface PendingViewFlush {
  readonly kind: 'config' | 'history';
  readonly direction?: 'undo' | 'redo';
  errorDetail: string | null;
}

type CellDisplay = EvaluatedCell & { readonly text: string; readonly accessibleText: string };

let nextViewFormId = 0;

/** Mount the Polaris Dados grid into the host-owned root. */
export function mountPolarisDados(context: DatabaseProviderContext): () => void {
  const { element, databaseId, data, locale, editable, signal } = context;
  const contextView: unknown = context.view;
  let viewVersionSupported = contextView === null || contextView === undefined;
  try {
    viewVersionSupported ||=
      typeof contextView === 'object' &&
      contextView !== null &&
      (contextView as { readonly version?: unknown }).version === 1;
  } catch {
    viewVersionSupported = false;
  }
  const unsupportedViewApi = contextView !== null && contextView !== undefined && !viewVersionSupported;
  const view: LinkedViewApi | null =
    viewVersionSupported && contextView ? (contextView as LinkedViewApi) : null;
  if (signal.aborted) return () => {};

  const document = element.ownerDocument;
  const messages = providerMessages(locale);
  const previousAttributes = new Map<string, string | null>(
    ['data-provider', 'role', 'aria-label', 'tabindex'].map((name) => [name, element.getAttribute(name)]),
  );
  element.dataset.provider = PROVIDER_ID;
  element.setAttribute('role', 'region');
  element.setAttribute('aria-label', messages.region);
  element.setAttribute('tabindex', '0');

  const container = document.createElement('div');
  container.className = 'polaris-dados';
  container.dataset.providerContent = PROVIDER_ID;
  container.style.color = 'var(--morrow-text, inherit)';
  container.style.font = 'inherit';
  element.replaceChildren(container);

  let currentSnapshot: DataApiSnapshot | null = null;
  let currentViewSnapshot: LinkedViewSnapshot | null = null;
  let draft: Draft | null = null;
  let viewDraft: LinkedViewDraft | null = null;
  let viewPanelOpen = false;
  let viewPendingFlush: PendingViewFlush | null = null;
  let viewBusy = false;
  let viewMutationInFlight = false;
  let pendingFlush: PendingFlush | null = null;
  let notice: Notice | null = null;
  let busy = false;
  let disposed = false;
  let unsubscribeData = () => {};
  let unsubscribeView = () => {};

  const captureFocus = (): FocusSnapshot => {
    const active = document.activeElement;
    if (!active || !element.contains(active)) {
      return { inside: false, key: null, selectionStart: null, selectionEnd: null };
    }
    let selectionStart: number | null = null;
    let selectionEnd: number | null = null;
    if (active.tagName === 'INPUT') {
      try {
        const input = active as HTMLInputElement;
        selectionStart = input.selectionStart;
        selectionEnd = input.selectionEnd;
      } catch {
        // Number inputs do not expose selection ranges in every WebView.
      }
    }
    return {
      inside: true,
      key: active.getAttribute('data-focus-key'),
      selectionStart,
      selectionEnd,
    };
  };

  const render = (focusRoot = false, focusOverride: string | null = null) => {
    if (disposed) return;
    const focus = captureFocus();
    const fragment = document.createDocumentFragment();

    if (unsupportedViewApi) {
      fragment.append(statusNode('error', messages.unsupportedViewApi));
    } else if (view) {
      fragment.append(renderViewToolbar());
      if (viewPanelOpen) fragment.append(renderViewSettingsPanel());
      if (currentViewSnapshot?.status === 'missing') {
        fragment.append(statusNode('error', messages.noDatabase));
      } else if (currentViewSnapshot?.status === 'unsupported') {
        fragment.append(statusNode('error', messages.noDatabase, currentViewSnapshot.diagnostic.message));
      } else if (!currentViewSnapshot) {
        fragment.append(statusNode('status', messages.loading));
      } else if (currentViewSnapshot.sourceStatus.status !== 'available') {
        fragment.append(
          statusNode('error', messages.noDatabase, currentViewSnapshot.sourceStatus.diagnostic?.message),
        );
      } else if (!currentSnapshot) {
        fragment.append(statusNode('status', messages.loading));
      } else if (currentSnapshot.status === 'missing') {
        fragment.append(statusNode('error', messages.noDatabase));
      } else if (currentSnapshot.status === 'unsupported') {
        fragment.append(statusNode('error', messages.noDatabase, currentSnapshot.diagnostic));
      } else if (currentViewSnapshot.status === 'ready') {
        const readySnapshot = currentSnapshot;
        if (readySnapshot?.status === 'ready') {
          const projection = projectLinkedView(
            readySnapshot,
            currentViewSnapshot.config,
            messages.rowTitleColumn,
          );
          fragment.append(renderLinkedGrid(readySnapshot, currentViewSnapshot.config));
          if (projection.filterUnavailable) fragment.append(statusNode('status', messages.filterUnavailable));
          if (
            currentViewSnapshot.config.columnOrder.some(
              (id) => !readySnapshot.schema.properties.some((property) => property.id === id),
            )
          ) {
            fragment.append(statusNode('status', messages.unavailableColumnReferences));
          }
        }
      }
      if (currentViewSnapshot?.status === 'ready' && currentViewSnapshot.readonly) {
        fragment.append(statusNode('status', messages.readonly, currentViewSnapshot.diagnostic?.message));
      }
    } else if (!currentSnapshot) {
      fragment.append(statusNode('status', messages.loading));
    } else if (currentSnapshot.status === 'missing') {
      fragment.append(statusNode('error', messages.noDatabase));
    } else if (currentSnapshot.status === 'unsupported') {
      fragment.append(statusNode('error', messages.noDatabase, currentSnapshot.diagnostic));
    } else {
      fragment.append(renderGrid(currentSnapshot));
    }
    if (!view) appendSnapshotNotice(fragment, currentSnapshot);
    if (draft && !draftIsVisible(currentSnapshot)) fragment.append(renderDetachedDraftNotice());
    appendCurrentNotice(fragment);
    container.replaceChildren(fragment);

    if (focusRoot) {
      element.focus({ preventScroll: true });
      return;
    }
    if (!focus.inside && !focusOverride) return;
    const key = focusOverride ?? focus.key;
    if (key) {
      const target = [...container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
        (candidate) => candidate.getAttribute('data-focus-key') === key,
      );
      if (!target) return;
      target.focus({ preventScroll: true });
      if (target.tagName === 'INPUT' && focus.selectionStart !== null && focus.selectionEnd !== null) {
        try {
          (target as HTMLInputElement).setSelectionRange(focus.selectionStart, focus.selectionEnd);
        } catch {
          // Number inputs do not expose selection ranges in every WebView.
        }
      }
      return;
    }
    if (document.activeElement !== element) element.focus({ preventScroll: true });
  };

  const renderViewToolbar = (): HTMLElement => {
    const toolbar = document.createElement('div');
    toolbar.dataset.viewToolbar = 'true';
    toolbar.style.display = 'flex';
    toolbar.style.alignItems = 'center';
    toolbar.style.gap = '0.5rem';
    const title = document.createElement('strong');
    title.textContent =
      currentViewSnapshot?.status === 'ready' ? currentViewSnapshot.config.title : messages.viewSettings;
    title.dataset.viewTitle = 'true';
    toolbar.append(title);
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.dataset.action = 'view-settings-toggle';
    settings.dataset.focusKey = 'view-settings-toggle';
    settings.textContent = messages.viewSettings;
    settings.setAttribute('aria-expanded', String(viewPanelOpen));
    settings.disabled =
      currentViewSnapshot?.status !== 'ready' ||
      viewBusy ||
      !!viewPendingFlush ||
      !!viewDraft?.staged ||
      !!draft;
    settings.addEventListener('click', toggleViewSettings);
    toolbar.append(settings);
    return toolbar;
  };

  const viewFormId = `polaris-view-${++nextViewFormId}`;

  const renderViewSettingsPanel = (): HTMLElement => {
    const panel = document.createElement('section');
    panel.dataset.viewSettings = 'true';
    panel.setAttribute('aria-label', messages.viewSettings);
    if (currentViewSnapshot?.status !== 'ready') {
      panel.append(statusNode('error', messages.noDatabase));
      return panel;
    }
    const config = currentViewSnapshot.config;
    const active = viewDraft;
    const properties = currentSnapshot?.status === 'ready' ? currentSnapshot.schema.properties : [];
    const filter = config.filter;
    const filterProperty = filter
      ? properties.find((property) => property.id === filter.propertyId && property.type === 'number')
      : null;
    const filterUnavailable = !!filter && !filterProperty;
    const readOnly =
      currentViewSnapshot.readonly ||
      !editable ||
      currentSnapshot?.status !== 'ready' ||
      currentSnapshot.readonly;

    const form = document.createElement('form');
    form.dataset.viewSettingsForm = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void saveViewDraft();
    });
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !viewDraft?.staged && !viewPendingFlush) {
        event.preventDefault();
        event.stopPropagation();
        cancelViewDraft();
      }
    });

    const titleLabel = document.createElement('label');
    titleLabel.htmlFor = `${viewFormId}-title`;
    titleLabel.textContent = messages.viewTitleLabel;
    const titleInput = document.createElement('input');
    titleInput.id = `${viewFormId}-title`;
    titleInput.type = 'text';
    titleInput.autocomplete = 'off';
    titleInput.value = active?.title ?? config.title;
    titleInput.disabled = readOnly || !active;
    titleInput.readOnly = !!active?.stale || !!active?.staged || !!draft || viewBusy || !!viewPendingFlush;
    titleInput.dataset.action = 'view-title';
    titleInput.addEventListener('input', () => {
      if (viewDraft) viewDraft.title = titleInput.value;
    });
    form.append(titleLabel, titleInput);

    const priority = document.createElement('fieldset');
    priority.dataset.viewPriorityList = 'true';
    const priorityLegend = document.createElement('legend');
    priorityLegend.textContent = messages.columnPriority;
    priority.append(priorityLegend);
    const priorityHint = document.createElement('p');
    priorityHint.textContent = messages.columnPriorityHint;
    priority.append(priorityHint);
    const priorityItems = document.createElement('div');
    priorityItems.dataset.viewPriorityItems = 'true';
    priority.append(priorityItems);
    renderPriorityItems(
      priorityItems,
      properties,
      active?.columnOrder ?? [...config.columnOrder],
      readOnly || !active || active.stale || active.staged || !!draft || viewBusy,
    );
    form.append(priority);
    ensureMissingColumnControls(
      form,
      properties,
      active?.columnOrder ?? config.columnOrder,
      readOnly || !active || active.stale || active.staged || !!draft || viewBusy,
    );

    const filterFieldset = document.createElement('fieldset');
    const filterLegend = document.createElement('legend');
    filterLegend.textContent = messages.filterLabel;
    filterFieldset.append(filterLegend);
    const filterPropertyLabel = document.createElement('label');
    filterPropertyLabel.htmlFor = `${viewFormId}-filter-property`;
    filterPropertyLabel.textContent = messages.filterPropertyLabel;
    const filterSelect = document.createElement('select');
    filterSelect.id = `${viewFormId}-filter-property`;
    filterSelect.dataset.action = 'view-filter-property';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = messages.filterNone;
    filterSelect.append(none);
    const currentFilterId = active?.filterPropertyId ?? filter?.propertyId ?? '';
    const validFilter = properties.some(
      (property) => property.id === currentFilterId && property.type === 'number',
    );
    if (filterUnavailable && !active?.filterTouched) {
      const unavailable = document.createElement('option');
      unavailable.value = currentFilterId;
      unavailable.dataset.unavailable = 'true';
      unavailable.textContent = messages.unavailableProperty;
      unavailable.disabled = true;
      filterSelect.append(unavailable);
    }
    for (const property of properties.filter((candidate) => candidate.type === 'number')) {
      const option = document.createElement('option');
      option.value = property.id;
      option.textContent = property.name;
      filterSelect.append(option);
    }
    filterSelect.value = validFilter || (filterUnavailable && !active?.filterTouched) ? currentFilterId : '';
    filterSelect.disabled = readOnly || !active || active.stale || active.staged || !!draft || viewBusy;
    filterSelect.addEventListener('change', () => {
      if (!viewDraft || filterSelect.selectedOptions[0]?.dataset.unavailable === 'true') return;
      viewDraft.filterPropertyId = filterSelect.value;
      viewDraft.filterTouched = true;
      refreshViewFilterValueState();
    });
    filterFieldset.append(filterPropertyLabel, filterSelect);

    const filterValueLabel = document.createElement('label');
    filterValueLabel.htmlFor = `${viewFormId}-filter-value`;
    filterValueLabel.textContent = messages.filterValueLabel;
    const filterValue = document.createElement('input');
    filterValue.id = `${viewFormId}-filter-value`;
    filterValue.type = 'number';
    filterValue.step = 'any';
    filterValue.value = active?.filterValue ?? (filter ? String(filter.value) : '');
    filterValue.dataset.action = 'view-filter-value';
    filterValue.disabled = readOnly || !active || !validFilter;
    filterValue.readOnly = !!active?.stale || !!active?.staged || !!draft || viewBusy || !!viewPendingFlush;
    filterValue.addEventListener('input', () => {
      if (!viewDraft) return;
      viewDraft.filterValue = filterValue.value;
      viewDraft.filterTouched = true;
    });
    filterFieldset.append(filterValueLabel, filterValue);
    if (filterUnavailable && !active?.filterTouched) {
      const warning = document.createElement('p');
      warning.setAttribute('role', 'status');
      warning.dataset.viewFilterWarning = 'true';
      warning.textContent = messages.filterUnavailable;
      filterFieldset.append(warning);
    }
    form.append(filterFieldset);

    const history = document.createElement('div');
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.dataset.action = 'view-undo';
    undo.dataset.focusKey = 'view-undo';
    undo.textContent = messages.undoView;
    undo.disabled =
      currentViewSnapshot.readonly ||
      !editable ||
      viewBusy ||
      !!viewPendingFlush ||
      !!draft ||
      !currentViewSnapshot.history.canUndo;
    undo.addEventListener('click', () => void applyViewHistory('undo'));
    const redo = document.createElement('button');
    redo.type = 'button';
    redo.dataset.action = 'view-redo';
    redo.dataset.focusKey = 'view-redo';
    redo.textContent = messages.redoView;
    redo.disabled =
      currentViewSnapshot.readonly ||
      !editable ||
      viewBusy ||
      !!viewPendingFlush ||
      !!draft ||
      !currentViewSnapshot.history.canRedo;
    redo.addEventListener('click', () => void applyViewHistory('redo'));
    history.append(undo, redo);
    form.append(history);

    const actions = document.createElement('div');
    const save = document.createElement('button');
    save.type = 'submit';
    save.dataset.action = 'view-save';
    save.dataset.focusKey = 'view-save';
    save.textContent = messages.save;
    save.disabled = readOnly || !active || active.stale || active.staged || !!draft || viewBusy;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'view-cancel';
    cancel.dataset.focusKey = 'view-cancel';
    cancel.textContent = messages.cancel;
    cancel.disabled = !active || active.staged || viewBusy;
    cancel.addEventListener('click', cancelViewDraft);
    actions.append(save, cancel);
    form.append(actions);
    panel.append(form);
    return panel;
  };

  const renderPriorityItems = (
    target: HTMLElement,
    properties: readonly ProviderProperty[],
    order: readonly string[],
    disabled: boolean,
  ) => {
    const activeElement = document.activeElement;
    const priorityFocus =
      activeElement instanceof document.defaultView!.HTMLElement &&
      element.contains(activeElement) &&
      target.contains(activeElement) &&
      activeElement.dataset.action &&
      activeElement.dataset.columnId
        ? {
            control: activeElement,
            action: activeElement.dataset.action,
            columnId: activeElement.dataset.columnId,
          }
        : null;
    target.replaceChildren();
    const knownIds = properties.map((property) => property.id);
    const priorityIds = order.filter((id) => knownIds.includes(id));
    properties.forEach((property) => {
      const row = document.createElement('div');
      const priorityButton = document.createElement('button');
      priorityButton.type = 'button';
      priorityButton.dataset.action = 'view-priority';
      priorityButton.dataset.columnId = property.id;
      priorityButton.setAttribute('aria-pressed', String(priorityIds.includes(property.id)));
      priorityButton.textContent = property.name;
      priorityButton.disabled = disabled;
      priorityButton.addEventListener('click', () => {
        if (!viewDraft) return;
        const nextPriorities = [...priorityIds];
        if (!priorityIds.includes(property.id)) nextPriorities.push(property.id);
        else nextPriorities.splice(nextPriorities.indexOf(property.id), 1);
        viewDraft.columnOrder = mergePrioritizedColumnOrder(viewDraft.columnOrder, knownIds, nextPriorities);
        renderPriorityItems(target, properties, viewDraft.columnOrder, disabled);
      });
      row.append(priorityButton);
      const priorityIndex = priorityIds.indexOf(property.id);
      if (priorityIndex >= 0) {
        row.append(
          createMoveButton('view-move-up', messages.moveUp, property.id, priorityIndex === 0 || disabled),
        );
        row.append(
          createMoveButton(
            'view-move-down',
            messages.moveDown,
            property.id,
            priorityIndex === priorityIds.length - 1 || disabled,
          ),
        );
      }
      target.append(row);
    });
    if (
      priorityFocus &&
      element.contains(target) &&
      (document.activeElement === priorityFocus.control ||
        document.activeElement === document.body ||
        document.activeElement === document.documentElement)
    ) {
      const candidates = [
        ...target.querySelectorAll<HTMLButtonElement>('button[data-action][data-column-id]'),
      ];
      const equivalent =
        candidates.find(
          (candidate) =>
            !candidate.disabled &&
            candidate.dataset.action === priorityFocus.action &&
            candidate.dataset.columnId === priorityFocus.columnId,
        ) ??
        candidates.find(
          (candidate) =>
            !candidate.disabled &&
            (candidate.dataset.action === 'view-move-up' || candidate.dataset.action === 'view-move-down') &&
            candidate.dataset.columnId === priorityFocus.columnId,
        ) ??
        candidates.find(
          (candidate) =>
            !candidate.disabled &&
            candidate.dataset.action === 'view-priority' &&
            candidate.dataset.columnId === priorityFocus.columnId,
        );
      equivalent?.focus({ preventScroll: true });
    }
  };

  const ensureMissingColumnControls = (
    form: HTMLFormElement,
    properties: readonly ProviderProperty[],
    order: readonly string[],
    disabled: boolean,
  ) => {
    const knownIds = properties.map((property) => property.id);
    const missing = order.some((id) => !knownIds.includes(id));
    let warning = form.querySelector<HTMLElement>('[data-missing-column-warning]');
    let remove = form.querySelector<HTMLButtonElement>('[data-action="view-remove-unavailable-columns"]');
    if (!missing) {
      warning?.remove();
      remove?.remove();
      return;
    }
    if (!warning) {
      warning = document.createElement('p');
      warning.setAttribute('role', 'status');
      warning.dataset.missingColumnWarning = 'true';
      warning.textContent = messages.unavailableColumnReferences;
      form.append(warning);
    }
    if (!remove) {
      remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.action = 'view-remove-unavailable-columns';
      remove.textContent = messages.removeUnavailableColumns;
      remove.addEventListener('click', () => {
        if (!viewDraft) return;
        const focusWasInRoot = document.activeElement === remove && element.contains(remove);
        const currentProperties =
          currentSnapshot?.status === 'ready' ? currentSnapshot.schema.properties : [];
        const currentIds = currentProperties.map((property) => property.id);
        viewDraft.columnOrder = viewDraft.columnOrder.filter((id) => currentIds.includes(id));
        const list = form.querySelector<HTMLElement>('[data-view-priority-items]');
        if (list) renderPriorityItems(list, currentProperties, viewDraft.columnOrder, false);
        ensureMissingColumnControls(form, currentProperties, viewDraft.columnOrder, false);
        if (
          focusWasInRoot &&
          (document.activeElement === remove ||
            document.activeElement === document.body ||
            document.activeElement === document.documentElement)
        ) {
          container.querySelector<HTMLButtonElement>('[data-action="view-settings-toggle"]')?.focus({
            preventScroll: true,
          });
        }
      });
      form.append(remove);
    }
    remove.disabled = disabled;
  };

  const createMoveButton = (
    action: 'view-move-up' | 'view-move-down',
    label: string,
    propertyId: string,
    disabled: boolean,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.dataset.columnId = propertyId;
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', () => {
      if (!viewDraft) return;
      const properties = currentSnapshot?.status === 'ready' ? currentSnapshot.schema.properties : [];
      const knownIds = properties.map((property) => property.id);
      const priorities = viewDraft.columnOrder.filter((id) => knownIds.includes(id));
      const index = priorities.indexOf(propertyId);
      const nextIndex = action === 'view-move-up' ? index - 1 : index + 1;
      if (index < 0 || nextIndex < 0 || nextIndex >= priorities.length) return;
      [priorities[index], priorities[nextIndex]] = [priorities[nextIndex]!, priorities[index]!];
      viewDraft.columnOrder = mergePrioritizedColumnOrder(viewDraft.columnOrder, knownIds, priorities);
      const target = container.querySelector<HTMLElement>('[data-view-priority-items]');
      if (target) renderPriorityItems(target, properties, viewDraft.columnOrder, false);
    });
    return button;
  };

  const refreshViewFilterValueState = () => {
    const select = container.querySelector<HTMLSelectElement>('[data-action="view-filter-property"]');
    const value = container.querySelector<HTMLInputElement>('[data-action="view-filter-value"]');
    if (!select || !value) return;
    select.value = viewDraft?.filterPropertyId ?? '';
    const valid =
      currentSnapshot?.status === 'ready' &&
      currentSnapshot.schema.properties.some(
        (property) => property.id === viewDraft?.filterPropertyId && property.type === 'number',
      );
    const hardReadonly =
      !viewDraft ||
      !editable ||
      currentViewSnapshot?.status !== 'ready' ||
      currentViewSnapshot.readonly ||
      currentSnapshot?.status !== 'ready' ||
      currentSnapshot.readonly;
    const draftLocked =
      viewBusy || !!viewPendingFlush || !!draft || !!viewDraft?.stale || !!viewDraft?.staged;
    value.disabled = !valid || hardReadonly;
    value.readOnly = !value.disabled && draftLocked;
  };

  const isViewDraftDirty = (): boolean => {
    if (!viewDraft || currentViewSnapshot?.status !== 'ready') return false;
    const config = currentViewSnapshot.config;
    return (
      viewDraft.title !== config.title ||
      JSON.stringify(viewDraft.columnOrder) !== JSON.stringify(config.columnOrder) ||
      (viewDraft.filterTouched && !sameFilterDraft(viewDraft, config))
    );
  };

  const sameFilterDraft = (candidate: LinkedViewDraft, config: LinkedViewConfig): boolean => {
    if (!candidate.filterTouched) return true;
    if (!candidate.filterPropertyId) return config.filter === null;
    const value = parseFiniteNumber(candidate.filterValue);
    return (
      !!value.ok &&
      config.filter?.propertyId === candidate.filterPropertyId &&
      config.filter.op === 'gte' &&
      config.filter.value === value.value
    );
  };

  const beginViewDraft = () => {
    if (!view || currentViewSnapshot?.status !== 'ready') {
      viewDraft = null;
      return;
    }
    const config = currentViewSnapshot.config;
    viewDraft = {
      expectedRevision: currentViewSnapshot.revision,
      title: config.title,
      columnOrder: [...config.columnOrder],
      filterPropertyId: config.filter?.propertyId ?? '',
      filterValue: config.filter ? String(config.filter.value) : '',
      filterTouched: false,
      stale: false,
      staged: false,
      errorDetail: null,
    };
  };

  const toggleViewSettings = () => {
    if (
      !view ||
      draft ||
      viewBusy ||
      viewPendingFlush ||
      viewDraft?.staged ||
      currentViewSnapshot?.status !== 'ready'
    )
      return;
    if (viewPanelOpen && viewDraft && isViewDraftDirty()) return;
    if (viewPanelOpen && viewDraft) {
      viewPanelOpen = false;
      viewDraft = null;
      notice = null;
    } else if (!viewPanelOpen) {
      viewPanelOpen = true;
      beginViewDraft();
    }
    render(false, 'view-settings-toggle');
  };

  const cancelViewDraft = () => {
    if (!viewDraft || viewDraft.staged || viewBusy || disposed) return;
    viewDraft = null;
    viewPanelOpen = false;
    notice = null;
    render(false, 'view-settings-toggle');
  };

  const saveViewDraft = async () => {
    if (
      !view ||
      !viewDraft ||
      !viewPanelOpen ||
      viewDraft.stale ||
      viewDraft.staged ||
      viewBusy ||
      draft ||
      disposed ||
      signal.aborted ||
      currentViewSnapshot?.status !== 'ready'
    )
      return;
    const active = viewDraft;
    const config = currentViewSnapshot.config;
    const patch: Partial<LinkedViewConfig> = {};
    if (active.title !== config.title) Object.assign(patch, { title: active.title });
    if (JSON.stringify(active.columnOrder) !== JSON.stringify(config.columnOrder))
      Object.assign(patch, { columnOrder: [...active.columnOrder] });
    if (active.filterTouched && !sameFilterDraft(active, config)) {
      if (!active.filterPropertyId) Object.assign(patch, { filter: null });
      else {
        const parsed = parseFiniteNumber(active.filterValue);
        const property =
          currentSnapshot?.status === 'ready'
            ? currentSnapshot.schema.properties.find(
                (candidate) => candidate.id === active.filterPropertyId && candidate.type === 'number',
              )
            : undefined;
        if (!property || !parsed.ok) {
          notice = { kind: 'error', message: messages.invalidNumber };
          refreshCurrentNotice();
          return;
        }
        Object.assign(patch, {
          filter: { propertyId: property.id, op: 'gte' as const, value: parsed.value },
        });
      }
    }
    if (!Object.keys(patch).length) {
      notice = { kind: 'status', message: messages.viewNoChanges };
      refreshCurrentNotice();
      return;
    }

    let result;
    viewMutationInFlight = true;
    try {
      result = view.patchConfig({ patch, expectedRevision: active.expectedRevision });
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      viewMutationInFlight = false;
    }
    if (signal.aborted || disposed) return;
    if (result.status === 'error') {
      active.errorDetail = result.message;
      if ('staged' in result && result.staged) {
        active.staged = true;
        viewPendingFlush = { kind: 'config', errorDetail: null };
        viewBusy = true;
        notice = { kind: 'status', message: messages.saving };
        refreshCurrentNotice();
        refreshViewFormState();
        await flushViewPending();
        return;
      } else if (result.code === 'stale-revision') {
        active.stale = true;
      }
      notice = {
        kind: 'error',
        message:
          result.code === 'stale-revision' ? messages.viewDraftStale : messages.saveError(result.message),
        detail: result.message,
      };
      refreshCurrentNotice();
      refreshViewFormState();
      return;
    }
    if (result.status === 'no-op') {
      currentViewSnapshot = view.snapshot();
      beginViewDraft();
      notice = { kind: 'status', message: messages.viewNoChanges };
      refreshCurrentNotice();
      refreshViewFormState();
      return;
    }
    active.staged = true;
    viewPendingFlush = { kind: 'config', errorDetail: null };
    viewBusy = true;
    notice = { kind: 'status', message: messages.saving };
    refreshCurrentNotice();
    refreshViewFormState();
    await flushViewPending();
  };

  const applyViewHistory = async (direction: 'undo' | 'redo') => {
    if (
      !view ||
      viewBusy ||
      viewPendingFlush ||
      disposed ||
      signal.aborted ||
      currentViewSnapshot?.status !== 'ready'
    )
      return;
    if (draft) {
      notice = { kind: 'status', message: messages.viewResolveDraft };
      refreshCurrentNotice();
      return;
    }
    if (viewDraft && isViewDraftDirty()) {
      notice = { kind: 'status', message: messages.viewResolveDraft };
      refreshCurrentNotice();
      return;
    }
    const expectedRevision = currentViewSnapshot.revision;
    let result;
    viewMutationInFlight = true;
    try {
      result = view.history({ direction, expectedRevision });
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      viewMutationInFlight = false;
    }
    if (signal.aborted || disposed) return;
    if (result.status === 'error') {
      if ('staged' in result && result.staged) {
        viewPendingFlush = { kind: 'history', direction, errorDetail: null };
        viewBusy = true;
        notice = { kind: 'status', message: messages.saving };
        refreshCurrentNotice();
        refreshViewFormState();
        await flushViewPending();
        return;
      }
      notice = { kind: 'error', message: messages.viewHistoryError(result.message), detail: result.message };
      refreshCurrentNotice();
      refreshViewFormState();
      return;
    }
    if (result.status === 'no-op') {
      notice = { kind: 'status', message: direction === 'undo' ? messages.viewNoUndo : messages.viewNoRedo };
      refreshCurrentNotice();
      return;
    }
    viewPendingFlush = { kind: 'history', direction, errorDetail: null };
    viewBusy = true;
    notice = { kind: 'status', message: messages.saving };
    refreshCurrentNotice();
    refreshViewFormState();
    await flushViewPending();
  };

  const flushViewPending = async () => {
    if (!view || !viewPendingFlush || disposed || signal.aborted) return;
    const pending = viewPendingFlush;
    viewBusy = true;
    pending.errorDetail = null;
    notice = { kind: 'status', message: messages.saving };
    refreshCurrentNotice();
    refreshViewFormState();
    let result;
    try {
      result = await view.flush();
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
        staged: true as const,
      };
    }
    if (signal.aborted || disposed) return;
    viewBusy = false;
    if (result.status === 'error') {
      pending.errorDetail = result.message;
      notice = { kind: 'error', message: messages.saveError(result.message), detail: result.message };
      refreshCurrentNotice();
      refreshViewFormState();
      return;
    }

    viewPendingFlush = null;
    try {
      currentViewSnapshot = view.snapshot();
    } catch {
      // The subscription remains authoritative if an immediate read fails after persistence.
    }
    if (pending.kind === 'config') {
      beginViewDraft();
      syncViewDraftControls();
    } else if (viewDraft) {
      beginViewDraft();
      syncViewDraftControls();
    }
    notice = { kind: 'status', message: messages.saved };
    if (viewDraft) {
      refreshCurrentNotice();
      refreshViewFormState();
      if (currentSnapshot?.status === 'ready') refreshLinkedTable();
    } else {
      render();
    }
  };

  const retryViewFlush = async () => {
    if (!viewPendingFlush || viewBusy || disposed || signal.aborted) return;
    await flushViewPending();
  };

  const refreshViewFormState = () => {
    const hardReadonly =
      !viewDraft ||
      !editable ||
      currentViewSnapshot?.status !== 'ready' ||
      currentViewSnapshot.readonly ||
      currentSnapshot?.status !== 'ready' ||
      currentSnapshot.readonly;
    const draftLocked =
      viewBusy || !!viewPendingFlush || !!draft || !!viewDraft?.stale || !!viewDraft?.staged;
    const disableEdit = hardReadonly || draftLocked;
    for (const control of [
      ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        '[data-action^="view-"]',
      ),
    ]) {
      const action = control.dataset.action;
      if (action === 'view-title' || action === 'view-filter-value') {
        const input = control as HTMLInputElement;
        input.disabled = hardReadonly;
        input.readOnly = !hardReadonly && draftLocked;
      } else if (action === 'view-settings-toggle')
        control.disabled =
          viewBusy ||
          !!draft ||
          !!viewPendingFlush ||
          !!viewDraft?.staged ||
          currentViewSnapshot?.status !== 'ready';
      else if (action === 'view-cancel') control.disabled = !viewDraft || !!viewDraft?.staged || viewBusy;
      else if (action === 'view-undo')
        control.disabled =
          disableEdit || currentViewSnapshot?.status !== 'ready' || !currentViewSnapshot.history.canUndo;
      else if (action === 'view-redo')
        control.disabled =
          disableEdit || currentViewSnapshot?.status !== 'ready' || !currentViewSnapshot.history.canRedo;
      else if (action === 'view-retry') control.disabled = viewBusy;
      else control.disabled = disableEdit;
    }
    refreshViewFilterValueState();
  };

  const syncViewDraftControls = () => {
    if (!viewDraft || currentViewSnapshot?.status !== 'ready') return;
    const form = container.querySelector<HTMLFormElement>('[data-view-settings-form]');
    if (!form) return;
    const properties = currentSnapshot?.status === 'ready' ? currentSnapshot.schema.properties : [];
    const titleInput = form.querySelector<HTMLInputElement>('[data-action="view-title"]');
    if (titleInput) titleInput.value = viewDraft.title;
    const priorityItems = form.querySelector<HTMLElement>('[data-view-priority-items]');
    const readOnly =
      currentViewSnapshot.readonly ||
      !editable ||
      currentSnapshot?.status !== 'ready' ||
      currentSnapshot.readonly;
    if (priorityItems)
      renderPriorityItems(
        priorityItems,
        properties,
        viewDraft.columnOrder,
        readOnly || viewDraft.stale || viewDraft.staged || !!draft || viewBusy,
      );
    ensureMissingColumnControls(
      form,
      properties,
      viewDraft.columnOrder,
      readOnly || viewDraft.stale || viewDraft.staged || !!draft || viewBusy,
    );

    const filterSelect = form.querySelector<HTMLSelectElement>('[data-action="view-filter-property"]');
    const filterValue = form.querySelector<HTMLInputElement>('[data-action="view-filter-value"]');
    if (filterSelect && filterValue) {
      const configFilter = currentViewSnapshot.config.filter;
      filterSelect.replaceChildren();
      const none = document.createElement('option');
      none.value = '';
      none.textContent = messages.filterNone;
      filterSelect.append(none);
      const valid =
        !!configFilter &&
        properties.some((property) => property.id === configFilter.propertyId && property.type === 'number');
      if (configFilter && !valid) {
        const unavailable = document.createElement('option');
        unavailable.value = configFilter.propertyId;
        unavailable.dataset.unavailable = 'true';
        unavailable.textContent = messages.unavailableProperty;
        unavailable.disabled = true;
        filterSelect.append(unavailable);
      }
      for (const property of properties.filter((candidate) => candidate.type === 'number')) {
        const option = document.createElement('option');
        option.value = property.id;
        option.textContent = property.name;
        filterSelect.append(option);
      }
      filterSelect.value = configFilter ? configFilter.propertyId : '';
      filterValue.value = configFilter ? String(configFilter.value) : '';
      const filterUnavailable = !!configFilter && !valid;
      let warning = form.querySelector<HTMLElement>('[data-view-filter-warning]');
      if (filterUnavailable && !warning) {
        warning = document.createElement('p');
        warning.setAttribute('role', 'status');
        warning.dataset.viewFilterWarning = 'true';
        warning.textContent = messages.filterUnavailable;
        filterValue.after(warning);
      } else if (!filterUnavailable) warning?.remove();
    }
    refreshViewFormState();
  };

  const refreshCurrentNotice = () => {
    container.querySelector(':scope > [data-current-notice]')?.remove();
    if (notice) appendCurrentNotice(container);
  };

  const refreshCellDraftControls = () => {
    if (!draft) return;
    const editor = [...container.querySelectorAll<HTMLElement>('[data-editor]')].find(
      (candidate) => candidate.dataset.editor === draft?.propertyId,
    );
    const save = editor?.querySelector<HTMLButtonElement>('[data-action="save"]');
    const cancel = editor?.querySelector<HTMLButtonElement>('[data-action="cancel"]');
    if (save)
      save.disabled =
        busy ||
        draft.errorCode === 'stale-revision' ||
        currentSnapshot?.status !== 'ready' ||
        currentSnapshot.readonly ||
        !editable;
    if (cancel) cancel.disabled = busy;
  };

  const renderGrid = (snapshot: ReadySnapshot): HTMLTableElement => {
    const table = document.createElement('table');
    table.className = 'polaris-dados-grid';
    table.setAttribute('aria-label', messages.table);
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';

    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    for (const property of snapshot.schema.properties) {
      const heading = document.createElement('th');
      heading.scope = 'col';
      heading.textContent = property.name;
      heading.dataset.columnId = property.id;
      heading.style.textAlign = 'start';
      heading.style.padding = '0.45rem 0.65rem';
      heading.style.borderBottom = '1px solid currentColor';
      heading.style.opacity = '0.75';
      headingRow.append(heading);
    }
    head.append(headingRow);
    table.append(head);

    const body = document.createElement('tbody');
    for (const row of snapshot.rows) body.append(renderRow(snapshot, row));
    table.append(body);
    return table;
  };

  const renderLinkedGrid = (snapshot: ReadySnapshot, config: LinkedViewConfig): HTMLTableElement => {
    const projection = projectLinkedView(snapshot, config, messages.rowTitleColumn);
    const table = document.createElement('table');
    table.className = 'polaris-dados-grid';
    table.setAttribute('aria-label', projection.title);
    table.style.borderCollapse = 'collapse';
    table.style.width = '100%';
    const caption = document.createElement('caption');
    caption.dataset.viewTitle = 'true';
    caption.textContent = projection.title;
    table.append(caption);

    const head = document.createElement('thead');
    const headingRow = document.createElement('tr');
    for (const column of projection.properties) {
      const heading = document.createElement('th');
      heading.scope = 'col';
      heading.textContent = column.name;
      heading.dataset.columnKey = column.key;
      if (column.kind === 'property') heading.dataset.columnId = column.id;
      heading.style.textAlign = 'start';
      heading.style.padding = '0.45rem 0.65rem';
      heading.style.borderBottom = '1px solid currentColor';
      heading.style.opacity = '0.75';
      headingRow.append(heading);
    }
    head.append(headingRow);
    table.append(head);

    const body = document.createElement('tbody');
    for (const row of projection.rows) body.append(renderLinkedRow(snapshot, row, projection.properties));
    table.append(body);
    return table;
  };

  const renderLinkedRow = (
    snapshot: ReadySnapshot,
    row: DataApiRow,
    columns: readonly PresentedProperty[],
  ): HTMLTableRowElement => {
    const tableRow = document.createElement('tr');
    tableRow.dataset.rowId = row.id;
    for (const column of columns) tableRow.append(renderLinkedCell(snapshot, row, column));
    return tableRow;
  };

  const renderLinkedCell = (
    snapshot: ReadySnapshot,
    row: DataApiRow,
    column: PresentedProperty,
  ): HTMLTableCellElement => {
    if (column.kind === 'property') {
      const cell = renderCell(snapshot, row, column.property);
      cell.dataset.columnKey = column.key;
      return cell;
    }
    const cell = document.createElement('td');
    cell.dataset.columnKey = column.key;
    cell.dataset.rowTitle = 'true';
    cell.style.padding = '0.45rem 0.65rem';
    cell.style.borderBottom = '1px solid currentColor';
    const title = document.createElement('span');
    title.textContent = row.title;
    title.setAttribute('aria-label', `${column.name}: ${row.title}`);
    cell.append(title);
    return cell;
  };

  const renderRow = (snapshot: ReadySnapshot, row: DataApiRow): HTMLTableRowElement => {
    const tableRow = document.createElement('tr');
    tableRow.dataset.rowId = row.id;
    for (const property of snapshot.schema.properties) {
      tableRow.append(renderCell(snapshot, row, property));
    }
    return tableRow;
  };

  const renderCell = (
    snapshot: ReadySnapshot,
    row: DataApiRow,
    property: ProviderProperty,
  ): HTMLTableCellElement => {
    const cell = document.createElement('td');
    cell.dataset.field = property.id;
    cell.style.padding = '0.45rem 0.65rem';
    cell.style.borderBottom = '1px solid currentColor';

    if (draft?.rowId === row.id && draft.propertyId === property.id) {
      cell.append(renderEditor(row, property));
    } else {
      const value = displayCell(row, snapshot.schema.properties, property);
      const canEdit =
        editable && !snapshot.readonly && property.type === 'number' && !busy && !pendingFlush && !viewDraft;
      if (canEdit) cell.append(renderEditButton(row, property, value, snapshot.revision));
      else cell.append(renderCellValue(property, value));
    }
    return cell;
  };

  const updateGridInPlace = (snapshot: ReadySnapshot): boolean => {
    const table = container.querySelector<HTMLTableElement>('table');
    const headingRow = table?.querySelector('thead tr');
    const renderedRows = [...(table?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])];
    if (
      !table ||
      !headingRow ||
      headingRow.children.length !== snapshot.schema.properties.length ||
      renderedRows.length !== snapshot.rows.length
    )
      return false;

    const headings = [...headingRow.querySelectorAll<HTMLTableCellElement>('th')];
    if (headings.some((heading, index) => heading.dataset.columnId !== snapshot.schema.properties[index]?.id))
      return false;
    if (renderedRows.some((row, index) => row.dataset.rowId !== snapshot.rows[index]?.id)) return false;
    if (renderedRows.some((row) => row.querySelectorAll('td').length !== snapshot.schema.properties.length))
      return false;

    for (let column = 0; column < snapshot.schema.properties.length; column += 1) {
      const property = snapshot.schema.properties[column]!;
      headings[column]!.textContent = property.name;
    }
    for (let rowIndex = 0; rowIndex < snapshot.rows.length; rowIndex += 1) {
      const row = snapshot.rows[rowIndex]!;
      const renderedRow = renderedRows[rowIndex]!;
      const cells = [...renderedRow.querySelectorAll<HTMLTableCellElement>('td')];
      for (let column = 0; column < snapshot.schema.properties.length; column += 1) {
        const property = snapshot.schema.properties[column]!;
        const cell = cells[column]!;
        if (draft?.rowId === row.id && draft.propertyId === property.id) {
          const save = cell.querySelector<HTMLButtonElement>('button[data-action="save"]');
          if (save)
            save.disabled = busy || draft.errorCode === 'stale-revision' || snapshot.readonly || !editable;
          continue;
        }
        cell.replaceWith(renderCell(snapshot, row, property));
      }
    }
    refreshNotices(snapshot);
    return true;
  };

  const updateLinkedGridInPlace = (snapshot: ReadySnapshot): boolean => {
    if (currentViewSnapshot?.status !== 'ready') return false;
    const projection = projectLinkedView(snapshot, currentViewSnapshot.config, messages.rowTitleColumn);
    const table = container.querySelector<HTMLTableElement>('table');
    const headingRow = table?.querySelector('thead tr');
    const renderedRows = [...(table?.querySelectorAll<HTMLTableRowElement>('tbody tr') ?? [])];
    if (
      !table ||
      !headingRow ||
      headingRow.children.length !== projection.properties.length ||
      renderedRows.length !== projection.rows.length
    )
      return false;
    const headings = [...headingRow.querySelectorAll<HTMLTableCellElement>('th')];
    if (headings.some((heading, index) => heading.dataset.columnKey !== projection.properties[index]?.key))
      return false;
    if (renderedRows.some((row, index) => row.dataset.rowId !== projection.rows[index]?.id)) return false;
    if (renderedRows.some((row) => row.querySelectorAll('td').length !== projection.properties.length))
      return false;
    if (
      renderedRows.some((row) =>
        [...row.querySelectorAll<HTMLTableCellElement>('td')].some(
          (cell, index) => cell.dataset.columnKey !== projection.properties[index]?.key,
        ),
      )
    )
      return false;

    table.setAttribute('aria-label', projection.title);
    const caption = table.querySelector('caption');
    if (caption) caption.textContent = projection.title;
    const toolbarTitle = container.querySelector<HTMLElement>('[data-view-toolbar] [data-view-title]');
    if (toolbarTitle) toolbarTitle.textContent = projection.title;
    for (let column = 0; column < projection.properties.length; column += 1) {
      headings[column]!.textContent = projection.properties[column]!.name;
    }
    for (let rowIndex = 0; rowIndex < projection.rows.length; rowIndex += 1) {
      const row = projection.rows[rowIndex]!;
      const renderedRow = renderedRows[rowIndex]!;
      const cells = [...renderedRow.querySelectorAll<HTMLTableCellElement>('td')];
      for (let columnIndex = 0; columnIndex < projection.properties.length; columnIndex += 1) {
        const column = projection.properties[columnIndex]!;
        const cell = cells[columnIndex]!;
        if (column.kind === 'property' && draft?.rowId === row.id && draft.propertyId === column.id) {
          const save = cell.querySelector<HTMLButtonElement>('button[data-action="save"]');
          if (save)
            save.disabled =
              busy || draft.errorCode === 'stale-revision' || snapshot.readonly || !editable || !!viewDraft;
          continue;
        }
        cell.replaceWith(renderLinkedCell(snapshot, row, column));
      }
    }
    refreshNotices(snapshot);
    return true;
  };

  const refreshLinkedTable = () => {
    if (!view || currentViewSnapshot?.status !== 'ready' || currentSnapshot?.status !== 'ready') return;
    const replacement = renderLinkedGrid(currentSnapshot, currentViewSnapshot.config);
    const previous = container.querySelector<HTMLTableElement>('table');
    if (previous) previous.replaceWith(replacement);
    else {
      const anchor =
        container.querySelector<HTMLElement>('[data-view-settings]') ??
        container.querySelector<HTMLElement>('[data-view-toolbar]');
      anchor?.after(replacement);
    }
    const toolbarTitle = container.querySelector<HTMLElement>('[data-view-toolbar] [data-view-title]');
    if (toolbarTitle) toolbarTitle.textContent = currentViewSnapshot.config.title;
    refreshNotices(currentSnapshot);
  };

  const renderEditButton = (
    row: DataApiRow,
    property: ProviderProperty,
    value: CellDisplay,
    revision: string,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = 'edit';
    button.dataset.rowId = row.id;
    button.dataset.field = property.id;
    button.dataset.focusKey = focusKey('edit', row.id, property.id);
    button.setAttribute('aria-label', messages.editCell(property.name, row.title));
    button.style.color = 'inherit';
    button.style.font = 'inherit';
    button.style.background = 'transparent';
    button.style.border = '0';
    button.style.padding = '0';
    button.style.cursor = 'pointer';
    button.append(renderCellValue(property, value));
    button.addEventListener('click', () => {
      if (busy || pendingFlush || disposed || signal.aborted || !editable || viewDraft) return;
      const latest = currentSnapshot;
      if (!latest || latest.status !== 'ready' || latest.readonly) return;
      draft = {
        rowId: row.id,
        propertyId: property.id,
        expectedRevision: revision,
        rawValue: value.kind === 'number' ? String(value.value) : '',
        errorCode: null,
        errorDetail: null,
      };
      notice = null;
      render(false, focusKey('input', row.id, property.id));
    });
    return button;
  };

  const renderEditor = (row: DataApiRow, property: ProviderProperty): HTMLElement => {
    const editor = document.createElement('div');
    editor.dataset.editor = property.id;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.autocomplete = 'off';
    input.value = draft?.rawValue ?? '';
    input.dataset.field = property.id;
    input.dataset.rowId = row.id;
    input.dataset.focusKey = focusKey('input', row.id, property.id);
    input.setAttribute('aria-label', messages.editorCell(property.name, row.title));
    input.addEventListener('input', () => {
      if (!draft || draft.rowId !== row.id || draft.propertyId !== property.id) return;
      draft.rawValue = input.value;
      if (draft.errorCode === 'stale-revision') return;
      draft.errorCode = null;
      draft.errorDetail = null;
      notice = null;
      if (currentSnapshot?.status === 'ready') updateGridInPlace(currentSnapshot);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void saveDraft();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelDraft();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        // WebKitGTK may not bind Ctrl+Z to the focused input's undo manager. Invoke its native
        // command explicitly; the resulting input event keeps the local draft in sync.
        event.stopPropagation();
        try {
          const command = event.shiftKey ? 'redo' : 'undo';
          if (input.ownerDocument.execCommand(command)) event.preventDefault();
        } catch {
          // Let the input's default editing behavior run when native undo is unavailable.
        }
      }
    });
    editor.append(input);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '0.35rem';
    const save = document.createElement('button');
    save.type = 'button';
    save.dataset.action = 'save';
    save.dataset.focusKey = focusKey('save', row.id, property.id);
    save.textContent = messages.save;
    save.disabled =
      busy ||
      draft?.errorCode === 'stale-revision' ||
      currentSnapshot?.status !== 'ready' ||
      currentSnapshot.readonly ||
      !editable;
    save.addEventListener('click', () => void saveDraft());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.focusKey = focusKey('cancel', row.id, property.id);
    cancel.textContent = messages.cancel;
    cancel.disabled = busy;
    cancel.addEventListener('click', cancelDraft);
    actions.append(save, cancel);
    editor.append(actions);
    return editor;
  };

  const renderCellValue = (property: ProviderProperty, value: CellDisplay): HTMLElement => {
    const wrapper = value.kind === 'error' ? document.createElement('div') : null;
    const output = document.createElement('span');
    output.dataset.valueKind = value.kind;
    output.dataset.propertyId = property.id;
    output.textContent = value.text;
    output.setAttribute('aria-label', `${property.name}: ${value.accessibleText}`);
    if (value.kind === 'error') {
      const details = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = messages.details;
      const content = document.createElement('code');
      content.textContent = value.message;
      details.append(heading, content);
      wrapper!.append(output, details);
    }
    return wrapper ?? output;
  };

  const displayCell = (
    row: DataApiRow,
    properties: readonly ProviderProperty[],
    property: ProviderProperty,
  ): CellDisplay => {
    let evaluated: EvaluatedCell;
    try {
      evaluated = evaluateCell(row, properties, property);
    } catch (error) {
      evaluated = {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    switch (evaluated.kind) {
      case 'missing':
        return { ...evaluated, text: messages.missing, accessibleText: messages.missing };
      case 'null':
        return { ...evaluated, text: messages.blank, accessibleText: messages.blank };
      case 'number': {
        const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }).format(evaluated.value);
        return { ...evaluated, text, accessibleText: text };
      }
      case 'boolean': {
        const text = evaluated.value ? messages.trueValue : messages.falseValue;
        return { ...evaluated, text, accessibleText: text };
      }
      case 'text':
        return { ...evaluated, text: evaluated.value, accessibleText: evaluated.value || messages.blank };
      case 'list': {
        const text = evaluated.value.map((item) => String(item)).join(', ');
        return { ...evaluated, text, accessibleText: text || messages.blank };
      }
      case 'error': {
        const text = messages.formulaError;
        return { ...evaluated, text, accessibleText: messages.formulaError };
      }
    }
  };

  const statusNode = (
    kind: 'status' | 'error',
    message: string,
    detail?: string | DataApiDiagnostic | null,
    action?: () => void,
    actionId = 'retry',
  ): HTMLElement => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    wrapper.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    wrapper.dataset.notice = kind;
    const summary = document.createElement('span');
    summary.textContent = message;
    wrapper.append(summary);

    const detailText = typeof detail === 'string' ? detail : detail?.message;
    if (detailText) {
      const details = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = messages.details;
      const content = document.createElement('code');
      content.textContent = detailText;
      details.append(heading, content);
      wrapper.append(details);
    }
    if (action) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.dataset.action = actionId;
      retry.dataset.focusKey = actionId === 'view-retry' ? 'view-retry' : 'retry-flush';
      retry.textContent = messages.retry;
      retry.disabled = busy || viewBusy;
      retry.addEventListener('click', action);
      wrapper.append(retry);
    }
    return wrapper;
  };

  const appendSnapshotNotice = (target: DocumentFragment, snapshot: DataApiSnapshot | null) => {
    if (snapshot?.status === 'ready' && snapshot.readonly) {
      target.append(statusNode('status', messages.readonly, snapshot.diagnostic));
    } else if (snapshot?.status === 'ready' && !editable) {
      target.append(statusNode('status', messages.readonly));
    }
  };

  const appendCurrentNotice = (target: DocumentFragment | HTMLElement) => {
    if (!notice) return;
    const viewRetry = !!viewPendingFlush?.errorDetail;
    const action = viewRetry
      ? () => void retryViewFlush()
      : pendingFlush?.errorDetail
        ? () => void retryFlush()
        : undefined;
    const current = statusNode(
      notice.kind,
      notice.message,
      notice.detail,
      action,
      viewRetry ? 'view-retry' : 'retry',
    );
    current.dataset.currentNotice = 'true';
    target.append(current);
  };

  const refreshNotices = (snapshot: DataApiSnapshot) => {
    for (const previous of [...container.querySelectorAll<HTMLElement>(':scope > [data-notice]')])
      previous.remove();
    const notices = document.createDocumentFragment();
    if (!view) appendSnapshotNotice(notices, snapshot);
    else if (snapshot.status === 'ready' && (snapshot.readonly || !editable)) {
      notices.append(statusNode('status', messages.readonly, snapshot.diagnostic));
    }
    if (view && currentViewSnapshot?.status === 'ready') {
      if (currentViewSnapshot.readonly)
        notices.append(statusNode('status', messages.readonly, currentViewSnapshot.diagnostic?.message));
      if (snapshot.status === 'ready') {
        const projection = projectLinkedView(snapshot, currentViewSnapshot.config, messages.rowTitleColumn);
        if (projection.filterUnavailable) notices.append(statusNode('status', messages.filterUnavailable));
        if (
          currentViewSnapshot.config.columnOrder.some(
            (id) => !snapshot.schema.properties.some((property) => property.id === id),
          )
        ) {
          notices.append(statusNode('status', messages.unavailableColumnReferences));
        }
      }
    }
    if (draft && !draftIsVisible(snapshot)) notices.append(renderDetachedDraftNotice());
    appendCurrentNotice(notices);
    container.append(notices);
  };

  const draftIsVisible = (snapshot: DataApiSnapshot | null): boolean =>
    !!draft &&
    snapshot?.status === 'ready' &&
    (view && currentViewSnapshot?.status === 'ready'
      ? projectLinkedView(snapshot, currentViewSnapshot.config, messages.rowTitleColumn).rows.some(
          (row) => row.id === draft?.rowId,
        )
      : snapshot.rows.some((row) => row.id === draft?.rowId)) &&
    snapshot.schema.properties.some((property) => property.id === draft?.propertyId);

  const renderDetachedDraftNotice = (): HTMLElement => {
    const wrapper = statusNode('error', messages.staleDraft, draft?.errorDetail);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.focusKey = 'cancel-detached-draft';
    cancel.textContent = messages.cancel;
    cancel.disabled = busy;
    cancel.addEventListener('click', cancelDraft);
    wrapper.append(cancel);
    return wrapper;
  };

  function snapshotUpdated(snapshot: DataApiSnapshot): void {
    if (disposed) return;
    currentSnapshot = snapshot;
    if (draft) {
      if (!busy && (snapshot.status !== 'ready' || snapshot.revision !== draft.expectedRevision)) {
        draft.errorCode = 'stale-revision';
        draft.errorDetail =
          snapshot.status === 'ready'
            ? 'This draft was opened from an older data revision.'
            : snapshot.status === 'unsupported'
              ? snapshot.diagnostic.message
              : 'The database is no longer available.';
        notice = { kind: 'error', message: messages.staleDraft, detail: draft.errorDetail };
      }
      if (view) {
        refreshCellDraftControls();
        refreshNotices(snapshot);
        return;
      }
      if (snapshot.status === 'ready' && updateGridInPlace(snapshot)) return;
    }
    if (viewDraft && view) {
      if (snapshot.status === 'ready' && !updateLinkedGridInPlace(snapshot)) refreshLinkedTable();
      else if (snapshot.status !== 'ready') refreshNotices(snapshot);
      return;
    }
    if (view && snapshot.status === 'ready' && updateLinkedGridInPlace(snapshot)) return;
    render();
  }

  function viewSnapshotUpdated(snapshot: LinkedViewSnapshot): void {
    if (disposed) return;
    currentViewSnapshot = snapshot;
    if (viewMutationInFlight) return;
    if (
      viewDraft &&
      !viewDraft.staged &&
      viewPendingFlush?.kind !== 'history' &&
      (snapshot.status !== 'ready' || snapshot.revision !== viewDraft.expectedRevision)
    ) {
      viewDraft.stale = true;
      notice = { kind: 'error', message: messages.viewDraftStale };
    }
    if (viewDraft || draft) {
      if (!draft && currentSnapshot?.status === 'ready' && !updateLinkedGridInPlace(currentSnapshot))
        refreshLinkedTable();
      if (currentSnapshot) refreshNotices(currentSnapshot);
      refreshCurrentNotice();
      refreshViewFormState();
      return;
    }
    if (currentSnapshot?.status === 'ready' && updateLinkedGridInPlace(currentSnapshot)) return;
    render();
  }

  function cancelDraft(): void {
    if (!draft || busy || disposed) return;
    draft = null;
    notice = null;
    render(true);
  }

  async function saveDraft(): Promise<void> {
    if (!draft || draft.errorCode === 'stale-revision' || busy || disposed || signal.aborted) return;
    const activeDraft = draft;
    const parsed = parseFiniteNumber(activeDraft.rawValue);
    if (!parsed.ok) {
      activeDraft.errorCode = 'invalid-value';
      activeDraft.errorDetail = null;
      notice = { kind: 'error', message: messages.invalidNumber };
      if (view) {
        refreshCurrentNotice();
        refreshCellDraftControls();
      } else if (
        !currentSnapshot ||
        currentSnapshot.status !== 'ready' ||
        !updateGridInPlace(currentSnapshot)
      )
        render();
      return;
    }

    busy = true;
    notice = { kind: 'status', message: messages.saving };
    if (view) {
      refreshCurrentNotice();
      refreshCellDraftControls();
    } else render();
    let result;
    try {
      result = data.patchCell({
        databaseId,
        rowId: activeDraft.rowId,
        propertyId: activeDraft.propertyId,
        value: parsed.value,
        expectedRevision: activeDraft.expectedRevision,
      });
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal.aborted || disposed) return;

    if (result.status === 'error') {
      busy = false;
      if (draft) {
        draft.errorCode = result.code;
        draft.errorDetail = result.message;
      }
      notice =
        result.code === 'stale-revision'
          ? { kind: 'error', message: messages.staleDraft, detail: result.message }
          : { kind: 'error', message: messages.saveError(result.message), detail: result.message };
      if (view) {
        refreshCurrentNotice();
        refreshCellDraftControls();
      } else if (
        !currentSnapshot ||
        currentSnapshot.status !== 'ready' ||
        !updateGridInPlace(currentSnapshot)
      )
        render();
      return;
    }

    draft = null;
    pendingFlush = {
      kind: 'cell',
      rowId: activeDraft.rowId,
      propertyId: activeDraft.propertyId,
      value: parsed.value,
      errorDetail: null,
    };
    notice = { kind: 'status', message: messages.saving };
    render(true);
    await flushPending();
  }

  async function applyHistory(direction: 'undo' | 'redo'): Promise<void> {
    if (busy || disposed || signal.aborted) return;
    if (view && (viewDraft || viewBusy || viewPendingFlush || draft)) {
      notice = { kind: 'status', message: messages.viewResolveDraft };
      refreshCurrentNotice();
      return;
    }
    let snapshot: DataApiSnapshot;
    try {
      snapshot = data.snapshot(databaseId);
    } catch (error) {
      notice = { kind: 'error', message: messages.saveError(String(error)), detail: String(error) };
      render(true);
      return;
    }
    if (snapshot.status !== 'ready') {
      notice = { kind: 'error', message: messages.noDatabase };
      render(true);
      return;
    }

    busy = true;
    notice = { kind: 'status', message: messages.saving };
    render(true);
    let result;
    try {
      result = data.history({ databaseId, direction, expectedRevision: snapshot.revision });
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal.aborted || disposed) return;
    if (result.status === 'error') {
      busy = false;
      notice = { kind: 'error', message: messages.saveError(result.message), detail: result.message };
      render(true);
      return;
    }
    if (result.status === 'no-op') {
      busy = false;
      notice = {
        kind: 'status',
        message: direction === 'undo' ? messages.nothingToUndo : messages.nothingToRedo,
      };
      render(true);
      return;
    }
    pendingFlush = { kind: 'history', errorDetail: null };
    await flushPending();
  }

  async function flushPending(): Promise<void> {
    if (!pendingFlush || disposed || signal.aborted) return;
    busy = true;
    pendingFlush.errorDetail = null;
    notice = { kind: 'status', message: messages.saving };
    render(true);
    let result;
    try {
      result = await data.flush(databaseId);
    } catch (error) {
      result = {
        status: 'error' as const,
        code: 'save-failed' as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (signal.aborted || disposed) return;
    busy = false;
    if (result.status === 'error') {
      pendingFlush.errorDetail = result.message;
      notice = { kind: 'error', message: messages.saveError(result.message), detail: result.message };
      render();
      return;
    }

    pendingFlush = null;
    notice = { kind: 'status', message: messages.saved };
    try {
      currentSnapshot = data.snapshot(databaseId);
    } catch {
      // The subscription remains the source of display updates; a snapshot failure must not hide success.
    }
    render();
  }

  async function retryFlush(): Promise<void> {
    if (!pendingFlush || busy || disposed || signal.aborted) return;
    await flushPending();
  }

  const onRootKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
    const activeElement = document.activeElement;
    if (isTextEditingTarget(activeElement, document) || isTextEditingTarget(event.target, document)) {
      // Preserve the input's native text undo and keep the host shortcut from handling this event.
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const inViewControls =
      !!view &&
      activeElement instanceof document.defaultView!.HTMLElement &&
      element.contains(activeElement) &&
      (!!activeElement.closest('[data-view-settings], [data-view-toolbar]') ||
        (viewPanelOpen && activeElement === element));
    if (inViewControls) void applyViewHistory(event.shiftKey ? 'redo' : 'undo');
    else void applyHistory(event.shiftKey ? 'redo' : 'undo');
  };

  const onAbort = () => cleanup();
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    unsubscribeData();
    unsubscribeView();
    element.removeEventListener('keydown', onRootKeyDown);
    signal.removeEventListener('abort', onAbort);
    container.replaceChildren();
    element.replaceChildren();
    for (const [name, previous] of previousAttributes) {
      if (previous === null) element.removeAttribute(name);
      else element.setAttribute(name, previous);
    }
  };

  element.addEventListener('keydown', onRootKeyDown);
  signal.addEventListener('abort', onAbort, { once: true });
  if (unsupportedViewApi) render();
  else {
    try {
      const unsubscribe = data.subscribe(databaseId, snapshotUpdated);
      if (disposed || signal.aborted) unsubscribe();
      else unsubscribeData = unsubscribe;
    } catch (error) {
      notice = {
        kind: 'error',
        message: messages.noDatabase,
        detail: error instanceof Error ? error.message : String(error),
      };
      render();
    }
    if (view) {
      try {
        const unsubscribe = view.subscribe(viewSnapshotUpdated);
        if (disposed || signal.aborted) unsubscribe();
        else unsubscribeView = unsubscribe;
      } catch (error) {
        notice = {
          kind: 'error',
          message: messages.noDatabase,
          detail: error instanceof Error ? error.message : String(error),
        };
        render();
      }
    }
  }
  if (signal.aborted) cleanup();
  return cleanup;
}

export function parseFiniteNumber(
  rawValue: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false } {
  if (rawValue.trim() === '') return { ok: false };
  const value = Number(rawValue);
  return Number.isFinite(value) ? { ok: true, value } : { ok: false };
}

function focusKey(action: string, rowId: string, propertyId: string): string {
  return `${action}:${rowId}:${propertyId}`;
}

function isTextEditingTarget(target: EventTarget | null, document: Document): boolean {
  const view = document.defaultView;
  if (!view || !(target instanceof view.HTMLElement)) return false;
  if (target instanceof view.HTMLTextAreaElement) return true;
  if (target instanceof view.HTMLInputElement) {
    return ['text', 'number', 'search', 'email', 'url', 'tel', 'password'].includes(target.type);
  }
  let ancestor: HTMLElement | null = target;
  while (ancestor) {
    const value = ancestor.getAttribute('contenteditable');
    if (value !== null) {
      switch (value.toLowerCase()) {
        case '':
        case 'true':
        case 'plaintext-only':
          return true;
        case 'false':
          return false;
      }
    }
    ancestor = ancestor.parentElement;
  }
  if (target.isContentEditable) return true;
  return false;
}
