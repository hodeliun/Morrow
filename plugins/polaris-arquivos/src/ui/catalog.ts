import type { VaultFileMetadata, VaultFilePage } from '../../../../src/app/platform/desktop';
import type { SupportedLocale } from '../../../../src/app/i18n';
import type { PluginSidebarFileCatalogHost } from '../../../../src/app/plugins/registry';
import {
  DEFAULT_FILE_CATALOG_PREFERENCES,
  fileCatalogExtensionPatch,
  fileCatalogExtensions,
  fileCatalogPreferencesAreDefault,
  fileExtension,
  hasVisibleDescendant,
  isFileCatalogFolderPathVisible,
  isFileCatalogPathVisible,
  normalizeFileCatalogPreferences,
  normalizeFileExtension,
} from '../model';
import type { FileCatalogPreferences } from '../model';

const PAGE_SIZE = 200;
const MAX_DISCOVERY_ENTRIES = 200_000;
const MAX_DISCOVERY_PATH_CHARS = 12_000_000;
const MAX_VISIBLE_EXTENSIONS = 500;

interface Messages {
  title: string;
  loading: string;
  empty: string;
  retry: string;
  loadMore: string;
  notFound: string;
  blocked: string;
  ioError: string;
  unavailable: string;
  stale: string;
  noMatchingFiles: string;
  settings: string;
  closeSettings: string;
  settingsTitle: string;
  selectedTypes: string;
  allTypes: string;
  includeExtensionless: string;
  showAttachments: string;
  searchExtensions: string;
  searchPlaceholder: string;
  addExtension: string;
  extensionPlaceholder: string;
  addButton: string;
  showTypes: string;
  hideTypes: string;
  showType: string;
  hideType: string;
  noTypes: string;
  reset: string;
  discovering: string;
  discoveryPartial: string;
  retryDiscovery: string;
  preferenceInvalid: string;
  preferenceUnavailable: string;
  moreTypes: string;
}

const messages: Record<SupportedLocale, Messages> = {
  pt: {
    title: 'Arquivos',
    loading: 'Carregando arquivos…',
    empty: 'Esta pasta está vazia.',
    retry: 'Tentar novamente',
    loadMore: 'Carregar mais',
    notFound: 'Esta pasta não foi encontrada.',
    blocked: 'Esta pasta não pode ser listada.',
    ioError: 'Não foi possível ler esta pasta.',
    unavailable: 'O catálogo de arquivos está indisponível.',
    stale: 'A sessão mudou. Tente novamente.',
    noMatchingFiles: 'Nenhum arquivo corresponde aos filtros.',
    settings: 'Filtrar arquivos',
    closeSettings: 'Fechar filtros',
    settingsTitle: 'Filtros do catálogo',
    selectedTypes: 'Tipos selecionados',
    allTypes: 'Todos os tipos',
    includeExtensionless: 'Incluir arquivos sem extensão',
    showAttachments: 'Mostrar anexos do cofre',
    searchExtensions: 'Buscar extensões',
    searchPlaceholder: 'Buscar por extensão',
    addExtension: 'Adicionar extensão',
    extensionPlaceholder: 'Ex.: .qzx',
    addButton: 'Adicionar',
    showTypes: 'Mostrar tipos',
    hideTypes: 'Ocultar tipos',
    showType: 'Mostrar .{extension}',
    hideType: 'Ocultar .{extension}',
    noTypes: 'Nenhuma extensão corresponde à busca.',
    reset: 'Restaurar padrão',
    discovering: 'Procurando extensões nas pastas do cofre…',
    discoveryPartial: 'Algumas pastas não puderam ser verificadas. Tipos conhecidos e personalizados continuam disponíveis.',
    retryDiscovery: 'Tentar descobrir novamente',
    preferenceInvalid: 'As preferências salvas estão inválidas. O catálogo usará os padrões até que possam ser salvas novamente.',
    preferenceUnavailable: 'Não foi possível acessar o armazenamento local. Os filtros valem apenas nesta sessão.',
    moreTypes: 'Refine a busca para ver mais extensões.',
  },
  en: {
    title: 'Files',
    loading: 'Loading files…',
    empty: 'This folder is empty.',
    retry: 'Try again',
    loadMore: 'Load more',
    notFound: 'This folder was not found.',
    blocked: 'This folder cannot be listed.',
    ioError: 'This folder could not be read.',
    unavailable: 'The file catalog is unavailable.',
    stale: 'The session changed. Try again.',
    noMatchingFiles: 'No files match these filters.',
    settings: 'Filter files',
    closeSettings: 'Close filters',
    settingsTitle: 'Catalog filters',
    selectedTypes: 'Selected types',
    allTypes: 'All types',
    includeExtensionless: 'Include files without an extension',
    showAttachments: 'Show vault attachments',
    searchExtensions: 'Search extensions',
    searchPlaceholder: 'Search extensions',
    addExtension: 'Add extension',
    extensionPlaceholder: 'For example, .qzx',
    addButton: 'Add',
    showTypes: 'Show types',
    hideTypes: 'Hide types',
    showType: 'Show .{extension}',
    hideType: 'Hide .{extension}',
    noTypes: 'No extensions match this search.',
    reset: 'Restore defaults',
    discovering: 'Discovering extensions in vault folders…',
    discoveryPartial: 'Some folders could not be checked. Known and custom types are still available.',
    retryDiscovery: 'Try discovery again',
    preferenceInvalid: 'Saved preferences are invalid. The catalog will use defaults until they can be saved again.',
    preferenceUnavailable: 'Local storage is unavailable. Filters apply only for this session.',
    moreTypes: 'Search to narrow the list of extensions.',
  },
  es: {
    title: 'Archivos',
    loading: 'Cargando archivos…',
    empty: 'Esta carpeta está vacía.',
    retry: 'Reintentar',
    loadMore: 'Cargar más',
    notFound: 'No se encontró esta carpeta.',
    blocked: 'No se puede listar esta carpeta.',
    ioError: 'No se pudo leer esta carpeta.',
    unavailable: 'El catálogo de archivos no está disponible.',
    stale: 'La sesión cambió. Inténtalo de nuevo.',
    noMatchingFiles: 'Ningún archivo coincide con estos filtros.',
    settings: 'Filtrar archivos',
    closeSettings: 'Cerrar filtros',
    settingsTitle: 'Filtros del catálogo',
    selectedTypes: 'Tipos seleccionados',
    allTypes: 'Todos los tipos',
    includeExtensionless: 'Incluir archivos sin extensión',
    showAttachments: 'Mostrar adjuntos de la bóveda',
    searchExtensions: 'Buscar extensiones',
    searchPlaceholder: 'Buscar extensiones',
    addExtension: 'Añadir extensión',
    extensionPlaceholder: 'Por ejemplo, .qzx',
    addButton: 'Añadir',
    showTypes: 'Mostrar tipos',
    hideTypes: 'Ocultar tipos',
    showType: 'Mostrar .{extension}',
    hideType: 'Ocultar .{extension}',
    noTypes: 'Ninguna extensión coincide con la búsqueda.',
    reset: 'Restaurar valores predeterminados',
    discovering: 'Buscando extensiones en las carpetas de la bóveda…',
    discoveryPartial: 'No se pudieron revisar algunas carpetas. Los tipos conocidos y personalizados siguen disponibles.',
    retryDiscovery: 'Intentar descubrir de nuevo',
    preferenceInvalid: 'Las preferencias guardadas no son válidas. El catálogo usará los valores predeterminados hasta poder guardarlas de nuevo.',
    preferenceUnavailable: 'No se puede acceder al almacenamiento local. Los filtros solo se aplican durante esta sesión.',
    moreTypes: 'Afina la búsqueda para ver más extensiones.',
  },
};

type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

interface DirectoryState {
  entries: VaultFileMetadata[];
  status: DirectoryStatus;
  loading: boolean;
  nextCursor: string | null;
  errorMessage: string | null;
  retryCursor: string | null;
  retryAppend: boolean;
}

const newDirectoryState = (): DirectoryState => ({
  entries: [],
  status: 'idle',
  loading: false,
  nextCursor: null,
  errorMessage: null,
  retryCursor: null,
  retryAppend: false,
});

function failureMessage(page: VaultFilePage, text: Messages): string {
  if (page.error) return page.error;
  switch (page.status) {
    case 'notFound':
      return text.notFound;
    case 'blocked':
      return text.blocked;
    case 'unavailable':
      return text.unavailable;
    case 'stale':
      return text.stale;
    default:
      return text.ioError;
  }
}

function isActive(host: PluginSidebarFileCatalogHost): boolean {
  try {
    return host.isActive();
  } catch {
    return false;
  }
}

function messageForPreferenceStatus(status: 'invalid' | 'unavailable', text: Messages): string {
  return status === 'invalid' ? text.preferenceInvalid : text.preferenceUnavailable;
}

export function mountFileCatalog(
  container: HTMLElement,
  host: PluginSidebarFileCatalogHost,
  locale: SupportedLocale = 'pt',
): () => void {
  const text = messages[locale] ?? messages.pt;
  const directories = new Map<string, DirectoryState>();
  const expanded = new Set<string>();
  const requests = new Map<string, number>();
  const discoveredFiles = new Set<string>();
  const discoveredExtensions = new Set<string>();
  let visibleFiles: string[] = [];
  let extensionOptions: string[] | null = null;
  let leaseGeneration: number | null = null;
  let preferences = normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES);
  let preferencesLoaded = false;
  let settingsOpen = false;
  let search = '';
  let extensionDraft = '';
  let preferenceMessage: string | null = null;
  let discoveryStatus: 'idle' | 'running' | 'ready' | 'partial' = 'idle';
  let discoveryToken = 0;
  let discoveryInFlight = false;
  let discoveryRestartRequested = false;
  let nextRequest = 0;
  let disposed = false;
  let searchSelection: { start: number; end: number } | null = null;

  const stateFor = (directory: string) => directories.get(directory) ?? newDirectoryState();
  const update = (directory: string, state: DirectoryState) => directories.set(directory, state);

  const makeMessage = (label: string, role: 'status' | 'alert' = 'status') => {
    const item = document.createElement('li');
    item.className = 'polaris-arquivos-message';
    item.setAttribute('role', role);
    item.textContent = label;
    return item;
  };

  const makeAction = (
    label: string,
    className: string,
    focusKey: string,
    onClick: () => void,
    disabled = false,
  ) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.dataset.focusKey = focusKey;
    button.textContent = label;
    button.setAttribute('aria-disabled', String(disabled));
    button.addEventListener('click', (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      onClick();
    });
    return button;
  };

  const recomputeVisibleFolders = () => {
    visibleFiles = [...discoveredFiles]
      .filter((path) => isFileCatalogPathVisible(path, preferences))
      .sort();
  };

  const loadPreferences = () => {
    if (preferencesLoaded) return;
    preferencesLoaded = true;
    let result: ReturnType<NonNullable<typeof host.readPreferences>> | undefined;
    try {
      result = host.readPreferences?.();
    } catch {
      result = undefined;
    }
    if (result?.status === 'ready') {
      preferences = result.value === null
        ? normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES)
        : normalizeFileCatalogPreferences(result.value);
      preferenceMessage = null;
    } else {
      preferences = normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES);
      preferenceMessage = messageForPreferenceStatus(result?.status ?? 'unavailable', text);
    }
    if (discoveryStatus === 'ready') recomputeVisibleFolders();
    render();
  };

  const persistPreferences = (next: FileCatalogPreferences) => {
    const writer = host.writePreferences;
    let result: ReturnType<NonNullable<typeof writer>> | undefined;
    try {
      result = writer?.(fileCatalogPreferencesAreDefault(next) ? null : next);
    } catch {
      result = undefined;
    }
    preferenceMessage = result?.status === 'saved'
      ? null
      : messageForPreferenceStatus(result?.status ?? 'unavailable', text);
  };

  const setPreferences = (patch: Partial<FileCatalogPreferences>) => {
    preferences = normalizeFileCatalogPreferences({ ...preferences, ...patch });
    extensionOptions = null;
    if (discoveryStatus === 'ready') recomputeVisibleFolders();
    persistPreferences(preferences);
    render();
  };

  const extensionList = () => {
    extensionOptions ??= fileCatalogExtensions([...discoveredExtensions], preferences);
    return extensionOptions;
  };

  const renderSettings = (section: HTMLElement) => {
    if (!settingsOpen) return;
    const panel = document.createElement('div');
    panel.className = 'polaris-arquivos-settings';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', text.settingsTitle);

    const header = document.createElement('div');
    header.className = 'polaris-arquivos-settings-heading';
    const title = document.createElement('h3');
    title.textContent = text.settingsTitle;
    const close = makeAction(text.closeSettings, 'polaris-arquivos-settings-close', 'settings-close', closeSettings);
    close.setAttribute('aria-label', text.closeSettings);
    header.append(title, close);
    panel.append(header);

    const mode = document.createElement('div');
    mode.className = 'polaris-arquivos-mode';
    mode.setAttribute('role', 'radiogroup');
    mode.setAttribute('aria-label', text.settingsTitle);
    for (const [value, label] of [['selected', text.selectedTypes], ['all', text.allTypes]] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `polaris-arquivos-mode-button${preferences.mode === value ? ' is-selected' : ''}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(preferences.mode === value));
      button.textContent = label;
      button.dataset.focusKey = `mode:${value}`;
      button.addEventListener('click', () => setPreferences({ mode: value }));
      mode.append(button);
    }
    panel.append(mode);

    const addSwitch = (label: string, checked: boolean, focusKey: string, change: (value: boolean) => void) => {
      const row = document.createElement('label');
      row.className = 'polaris-arquivos-switch';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.dataset.focusKey = focusKey;
      input.addEventListener('change', () => change(input.checked));
      const caption = document.createElement('span');
      caption.textContent = label;
      row.append(input, caption);
      panel.append(row);
    };
    addSwitch(text.includeExtensionless, preferences.includeExtensionless, 'extensionless', (includeExtensionless) =>
      setPreferences({ includeExtensionless }),
    );
    addSwitch(text.showAttachments, preferences.showAttachments, 'attachments', (showAttachments) =>
      setPreferences({ showAttachments }),
    );

    const searchLabel = document.createElement('label');
    searchLabel.className = 'polaris-arquivos-settings-label';
    searchLabel.textContent = text.searchExtensions;
    const searchInput = document.createElement('input');
    searchInput.className = 'polaris-arquivos-search';
    searchInput.type = 'search';
    searchInput.value = search;
    searchInput.placeholder = text.searchPlaceholder;
    searchInput.setAttribute('aria-label', text.searchExtensions);
    searchInput.dataset.focusKey = 'extension-search';
    searchInput.addEventListener('input', () => {
      search = searchInput.value;
      searchSelection = { start: searchInput.selectionStart ?? search.length, end: searchInput.selectionEnd ?? search.length };
      render();
    });
    searchLabel.append(searchInput);
    panel.append(searchLabel);

    const form = document.createElement('form');
    form.className = 'polaris-arquivos-add-form';
    const addLabel = document.createElement('label');
    addLabel.className = 'polaris-arquivos-settings-label';
    addLabel.textContent = text.addExtension;
    const controls = document.createElement('div');
    controls.className = 'polaris-arquivos-add-controls';
    const extensionInput = document.createElement('input');
    extensionInput.className = 'polaris-arquivos-search';
    extensionInput.value = extensionDraft;
    extensionInput.maxLength = 33;
    extensionInput.setAttribute('aria-label', text.addExtension);
    extensionInput.placeholder = text.extensionPlaceholder;
    extensionInput.dataset.focusKey = 'extension-add';
    extensionInput.addEventListener('input', () => {
      extensionDraft = extensionInput.value;
      addButton.disabled = !normalizeFileExtension(extensionDraft);
    });
    const addButton = document.createElement('button');
    addButton.type = 'submit';
    addButton.className = 'polaris-arquivos-add-button';
    addButton.textContent = text.addButton;
    addButton.disabled = !normalizeFileExtension(extensionDraft);
    controls.append(extensionInput, addButton);
    addLabel.append(controls);
    form.append(addLabel);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const extension = normalizeFileExtension(extensionDraft);
      if (!extension) return;
      setPreferences({
        customExtensions: [...preferences.customExtensions, extension],
        selectedExtensions: [...preferences.selectedExtensions, extension],
        hiddenExtensions: preferences.hiddenExtensions.filter((item) => item !== extension),
      });
      extensionDraft = '';
      render();
      container.querySelector<HTMLElement>('[data-focus-key="extension-add"]')?.focus();
    });
    panel.append(form);

    const typeSet = document.createElement('fieldset');
    typeSet.className = 'polaris-arquivos-types';
    const legend = document.createElement('legend');
    legend.textContent = preferences.mode === 'all' ? text.hideTypes : text.showTypes;
    typeSet.append(legend);
    const typeList = document.createElement('div');
    typeList.className = 'polaris-arquivos-type-list';
    const searchValue = search.trim().replace(/^\./, '').toLowerCase();
    const allExtensions = extensionList();
    let visibleExtensions: string[];
    let hasMoreExtensions: boolean;
    if (searchValue) {
      visibleExtensions = [];
      for (const extension of allExtensions) {
        if (!extension.includes(searchValue)) continue;
        visibleExtensions.push(extension);
        if (visibleExtensions.length > MAX_VISIBLE_EXTENSIONS) break;
      }
      hasMoreExtensions = visibleExtensions.length > MAX_VISIBLE_EXTENSIONS;
      visibleExtensions = visibleExtensions.slice(0, MAX_VISIBLE_EXTENSIONS);
    } else {
      visibleExtensions = [...new Set([...allExtensions.slice(0, MAX_VISIBLE_EXTENSIONS), ...preferences.customExtensions])];
      const visible = new Set(visibleExtensions);
      hasMoreExtensions = allExtensions.some((extension) => !visible.has(extension));
    }
    for (const extension of visibleExtensions) {
      const label = document.createElement('label');
      label.className = 'polaris-arquivos-type';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const checked = preferences.mode === 'all'
        ? preferences.hiddenExtensions.includes(extension)
        : preferences.selectedExtensions.includes(extension);
      checkbox.checked = checked;
      checkbox.setAttribute('aria-label', (preferences.mode === 'all' ? text.hideType : text.showType)
        .replace('{extension}', extension));
      checkbox.dataset.focusKey = `extension:${extension}`;
      checkbox.addEventListener('change', () =>
        setPreferences(fileCatalogExtensionPatch(preferences, extension, checkbox.checked)),
      );
      const name = document.createElement('span');
      name.textContent = `.${extension}`;
      label.append(checkbox, name);
      typeList.append(label);
    }
    if (visibleExtensions.length === 0) typeList.append(makeMessage(text.noTypes));
    else if (hasMoreExtensions) typeList.append(makeMessage(text.moreTypes));
    typeSet.append(typeList);
    panel.append(typeSet);

    if (discoveryStatus === 'running') panel.append(makeMessage(text.discovering));
    if (discoveryStatus === 'partial') {
      const status = document.createElement('div');
      status.className = 'polaris-arquivos-discovery-status';
      status.append(makeMessage(text.discoveryPartial));
      status.append(makeAction(text.retryDiscovery, 'polaris-arquivos-retry-discovery', 'retry-discovery', () => {
        discoveryStatus = 'idle';
        void startDiscovery();
      }));
      panel.append(status);
    }
    if (preferenceMessage) panel.append(makeMessage(preferenceMessage, 'alert'));

    const actions = document.createElement('div');
    actions.className = 'polaris-arquivos-settings-actions';
    actions.append(makeAction(text.reset, 'polaris-arquivos-reset', 'settings-reset', () => {
      preferences = normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES);
      extensionOptions = null;
      if (discoveryStatus === 'ready') recomputeVisibleFolders();
      persistPreferences(preferences);
      render();
    }));
    panel.append(actions);
    section.append(panel);
  };

  const renderDirectory = (directory: string, list: HTMLUListElement) => {
    const state = stateFor(directory);
    if (state.entries.length === 0 && state.status === 'loading') {
      list.append(makeMessage(text.loading));
      if (state.errorMessage) {
        const error = makeMessage(state.errorMessage, 'alert');
        error.append(makeAction(text.retry, 'polaris-arquivos-retry', `retry:${directory}`, () => {
          void load(directory, state.retryCursor, state.retryAppend);
        }, state.loading));
        list.append(error);
      }
      return;
    }
    if (state.entries.length === 0 && state.status === 'empty') {
      list.append(makeMessage(text.empty));
      return;
    }
    if (state.entries.length === 0 && state.status === 'error') {
      const error = makeMessage(state.errorMessage ?? text.ioError, 'alert');
      error.append(makeAction(text.retry, 'polaris-arquivos-retry', `retry:${directory}`, () => {
        void load(directory, state.retryCursor, state.retryAppend);
      }, state.loading));
      list.append(error);
      return;
    }

    const visibleEntries = state.entries.filter((entry) => {
      if (entry.kind === 'file') return isFileCatalogPathVisible(entry.path, preferences);
      if (!isFileCatalogFolderPathVisible(entry.path, preferences)) return false;
      return discoveryStatus !== 'ready' || hasVisibleDescendant(visibleFiles, entry.path);
    });
    for (const entry of visibleEntries) {
      const row = document.createElement('li');
      row.className = 'polaris-arquivos-row';
      if (entry.kind === 'folder') {
        const open = expanded.has(entry.path);
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'polaris-arquivos-folder-button';
        toggle.dataset.focusKey = `folder:${entry.path}`;
        toggle.setAttribute('aria-expanded', String(open));
        const chevron = document.createElement('span');
        chevron.className = 'polaris-arquivos-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        chevron.textContent = open ? '⌄' : '›';
        const name = document.createElement('span');
        name.className = 'polaris-arquivos-name';
        name.textContent = entry.name;
        toggle.append(chevron, name);
        toggle.addEventListener('click', () => {
          if (expanded.has(entry.path)) {
            expanded.delete(entry.path);
            render();
          } else {
            expanded.add(entry.path);
            if (stateFor(entry.path).status === 'idle') void load(entry.path, null, false);
            else render();
          }
        });
        row.append(toggle);
        if (open) {
          const childList = document.createElement('ul');
          childList.setAttribute('aria-label', entry.name);
          renderDirectory(entry.path, childList);
          row.append(childList);
        }
      } else {
        const name = document.createElement('span');
        name.className = 'polaris-arquivos-name polaris-arquivos-file-name';
        name.textContent = entry.name;
        row.append(name);
      }
      list.append(row);
    }

    if (visibleEntries.length === 0 && state.entries.length > 0 && !state.loading && !state.errorMessage) {
      list.append(makeMessage(text.noMatchingFiles));
    }
    if (state.loading) list.append(makeMessage(text.loading));
    if (state.errorMessage) {
      const error = makeMessage(state.errorMessage, 'alert');
      error.append(makeAction(text.retry, 'polaris-arquivos-retry', `retry:${directory}`, () => {
        void load(directory, state.retryCursor, state.retryAppend);
      }, state.loading));
      list.append(error);
    }
    if (state.nextCursor) {
      const action = document.createElement('li');
      action.className = 'polaris-arquivos-actions';
      action.append(
        makeAction(
          text.loadMore,
          'polaris-arquivos-more',
          `more:${directory}`,
          () => void load(directory, state.nextCursor, true),
          state.loading,
        ),
      );
      list.append(action);
    }
  };

  function render() {
    if (disposed) return;
    const activeElement = document.activeElement;
    const focusedKey =
      activeElement instanceof HTMLElement && container.contains(activeElement)
        ? activeElement.dataset.focusKey ?? null
        : null;
    const scrollable = container.closest<HTMLElement>('.sidebar-scroll');
    const scrollTop = scrollable?.scrollTop ?? 0;

    const section = document.createElement('section');
    section.className = 'sidebar-section polaris-arquivos';
    section.setAttribute('aria-label', text.title);
    const heading = document.createElement('div');
    heading.className = 'polaris-arquivos-header';
    const title = document.createElement('h2');
    title.className = 'sidebar-heading';
    title.tabIndex = -1;
    title.dataset.focusKey = 'heading';
    title.textContent = text.title;
    const settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.className = 'polaris-arquivos-settings-toggle';
    settingsButton.textContent = text.settings;
    settingsButton.setAttribute('aria-expanded', String(settingsOpen));
    settingsButton.setAttribute('aria-label', settingsOpen ? text.closeSettings : text.settings);
    settingsButton.dataset.focusKey = 'settings-toggle';
    settingsButton.addEventListener('click', () => {
      if (settingsOpen) closeSettings();
      else openSettings();
    });
    heading.append(title, settingsButton);
    section.append(heading);
    renderSettings(section);

    const rootList = document.createElement('ul');
    rootList.className = 'polaris-arquivos-tree';
    renderDirectory('', rootList);
    section.append(rootList);
    container.replaceChildren(section);

    if (focusedKey) {
      const restoreKey = focusedKey === 'settings-close' ? 'settings-toggle' : focusedKey;
      const focusTarget = [...container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
        (candidate) => candidate.dataset.focusKey === restoreKey,
      );
      (focusTarget ?? title).focus({ preventScroll: true });
      if (restoreKey === 'extension-search' && focusTarget instanceof HTMLInputElement && searchSelection) {
        focusTarget.setSelectionRange(searchSelection.start, searchSelection.end);
      }
    }
    if (scrollable) scrollable.scrollTop = scrollTop;
  }

  async function load(directory: string, cursor: string | null, append: boolean): Promise<void> {
    if (disposed || !isActive(host) || stateFor(directory).loading) return;
    const requestId = ++nextRequest;
    requests.set(directory, requestId);
    const previous = stateFor(directory);
    update(directory, {
      ...previous,
      status: previous.entries.length === 0 ? 'loading' : previous.status,
      loading: true,
      errorMessage: previous.errorMessage,
      retryCursor: cursor,
      retryAppend: append,
    });
    render();

    const listFilesPage = host.listFilesPage;
    if (typeof listFilesPage !== 'function') {
      update(directory, {
        ...stateFor(directory),
        status: 'error',
        loading: false,
        errorMessage: text.unavailable,
      });
      render();
      return;
    }

    try {
      const page = await listFilesPage(directory, cursor, PAGE_SIZE);
      if (disposed || !isActive(host) || requests.get(directory) !== requestId) return;
      if (page.status === 'ready' || page.status === 'empty') {
        if (directory === '' && cursor === null && leaseGeneration === null) {
          leaseGeneration = page.generation;
          loadPreferences();
          if (settingsOpen) void startDiscovery();
        }
        const entries = append ? [...previous.entries, ...page.entries] : page.entries;
        update(directory, {
          entries,
          status: entries.length > 0 ? 'ready' : 'empty',
          loading: false,
          nextCursor: page.nextCursor,
          errorMessage: null,
          retryCursor: null,
          retryAppend: false,
        });
      } else {
        update(directory, {
          ...previous,
          status: previous.entries.length > 0 ? 'ready' : 'error',
          loading: false,
          errorMessage: failureMessage(page, text),
          retryCursor: cursor,
          retryAppend: append,
        });
      }
    } catch {
      if (disposed || !isActive(host) || requests.get(directory) !== requestId) return;
      update(directory, {
        ...previous,
        status: previous.entries.length > 0 ? 'ready' : 'error',
        loading: false,
        errorMessage: text.ioError,
        retryCursor: cursor,
        retryAppend: append,
      });
    }
    render();
  }

  function closeSettings(): void {
    settingsOpen = false;
    if (discoveryStatus === 'running') {
      discoveryToken += 1;
      discoveryStatus = 'idle';
    }
    discoveryRestartRequested = false;
    render();
  }

  function openSettings(): void {
    settingsOpen = true;
    loadPreferences();
    render();
    if (discoveryStatus === 'idle') void startDiscovery();
  }

  async function startDiscovery(): Promise<void> {
    if (disposed || !settingsOpen || !isActive(host) || leaseGeneration === null || typeof host.listFilesPage !== 'function') return;
    if (discoveryInFlight) {
      discoveryRestartRequested = true;
      discoveryStatus = 'running';
      render();
      return;
    }
    if (discoveryStatus === 'running' || discoveryStatus === 'ready') return;
    discoveredFiles.clear();
    discoveredExtensions.clear();
    visibleFiles = [];
    extensionOptions = null;
    const token = ++discoveryToken;
    const generation = leaseGeneration;
    discoveryStatus = 'running';
    discoveryInFlight = true;
    render();

    try {
      await scanDiscovery(token, generation);
    } finally {
      discoveryInFlight = false;
      if (discoveryRestartRequested) {
        discoveryRestartRequested = false;
        if (!disposed && settingsOpen && isActive(host)) {
          discoveryStatus = 'idle';
          void startDiscovery();
        }
      }
    }
  }

  async function scanDiscovery(token: number, generation: number): Promise<void> {
    const listFilesPage = host.listFilesPage;
    if (typeof listFilesPage !== 'function') return;
    const queue = [''];
    const queued = new Set(queue);
    let queueIndex = 0;
    let discoveredCount = 0;
    let discoveredPathChars = 0;
    let partial = false;
    let stop = false;

    const current = () =>
      !disposed && settingsOpen && discoveryToken === token && isActive(host) && leaseGeneration === generation;

    while (queueIndex < queue.length && current() && !stop) {
      const directory = queue[queueIndex++]!;
      let cursor: string | null = null;
      const seenCursors = new Set<string>();
      let directoryDone = false;
      while (!directoryDone && current()) {
        const cursorKey = cursor ?? '';
        if (seenCursors.has(cursorKey)) {
          partial = true;
          break;
        }
        seenCursors.add(cursorKey);
        let page: VaultFilePage;
        try {
          page = await listFilesPage(directory, cursor, PAGE_SIZE);
        } catch {
          partial = true;
          break;
        }
        if (!current()) return;
        if (page.status === 'stale' || page.generation !== generation) {
          discoveryToken += 1;
          discoveryStatus = 'idle';
          render();
          return;
        }
        if (page.status !== 'ready' && page.status !== 'empty') {
          partial = true;
          break;
        }

        for (const entry of page.entries) {
          discoveredCount += 1;
          if (discoveredCount > MAX_DISCOVERY_ENTRIES) {
            partial = true;
            stop = true;
            break;
          }
          discoveredPathChars += Math.max(entry.path.length, entry.path.toLowerCase().length);
          if (discoveredPathChars > MAX_DISCOVERY_PATH_CHARS) {
            partial = true;
            stop = true;
            break;
          }
          if (entry.kind === 'folder') {
            if (!queued.has(entry.path) && queue.length < MAX_DISCOVERY_ENTRIES) {
              queued.add(entry.path);
              queue.push(entry.path);
            } else if (!queued.has(entry.path)) {
              partial = true;
              stop = true;
              break;
            }
          } else {
            discoveredFiles.add(entry.path.toLowerCase());
            const extension = normalizeFileExtension(fileExtension(entry.path));
            if (extension && !discoveredExtensions.has(extension)) {
              discoveredExtensions.add(extension);
              extensionOptions = null;
            }
          }
        }
        if (stop) break;
        if (page.nextCursor) {
          if (seenCursors.has(page.nextCursor)) {
            partial = true;
            break;
          }
          cursor = page.nextCursor;
        } else {
          directoryDone = true;
        }
      }
    }

    if (!current()) return;
    discoveryStatus = partial ? 'partial' : 'ready';
    if (discoveryStatus === 'ready') recomputeVisibleFolders();
    render();
  }

  render();
  void load('', null, false);

  return () => {
    if (disposed) return;
    disposed = true;
    discoveryToken += 1;
    discoveryRestartRequested = false;
    requests.clear();
    container.replaceChildren();
  };
}
