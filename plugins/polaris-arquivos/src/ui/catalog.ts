import type { VaultFileMetadata, VaultFilePage } from '../../../../src/app/platform/desktop';
import type { SupportedLocale } from '../../../../src/app/i18n';
import type { PluginSidebarFileCatalogHost } from '../../../../src/app/plugins/registry';

const PAGE_SIZE = 200;

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
  },
  es: {
    title: 'Archivos',
    loading: 'Cargando archivos…',
    empty: 'Esta carpeta está vacía.',
    retry: 'Intentar de nuevo',
    loadMore: 'Cargar más',
    notFound: 'No se encontró esta carpeta.',
    blocked: 'No se puede listar esta carpeta.',
    ioError: 'No se pudo leer esta carpeta.',
    unavailable: 'El catálogo de archivos no está disponible.',
    stale: 'La sesión cambió. Inténtalo de nuevo.',
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

export function mountFileCatalog(
  container: HTMLElement,
  host: PluginSidebarFileCatalogHost,
  locale: SupportedLocale = 'pt',
): () => void {
  const text = messages[locale] ?? messages.pt;
  const directories = new Map<string, DirectoryState>();
  const expanded = new Set<string>();
  const requests = new Map<string, number>();
  let nextRequest = 0;
  let disposed = false;

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

  const renderDirectory = (directory: string, list: HTMLUListElement) => {
    const state = stateFor(directory);
    if (state.entries.length === 0 && state.status === 'loading') {
      list.append(makeMessage(text.loading));
      if (state.errorMessage) {
        const error = makeMessage(state.errorMessage, 'alert');
        const actions = document.createElement('span');
        actions.className = 'polaris-arquivos-actions';
        actions.append(
          makeAction(
            text.retry,
            'polaris-arquivos-retry',
            `retry:${directory}`,
            () => void load(directory, state.retryCursor, state.retryAppend),
            true,
          ),
        );
        error.append(actions);
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
      const actions = document.createElement('span');
      actions.className = 'polaris-arquivos-actions';
      actions.append(
        makeAction(text.retry, 'polaris-arquivos-retry', `retry:${directory}`, () => {
          void load(directory, state.retryCursor, state.retryAppend);
        }, state.loading),
      );
      error.append(actions);
      list.append(error);
      return;
    }

    for (const entry of state.entries) {
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

    if (state.loading) list.append(makeMessage(text.loading));
    if (state.errorMessage) {
      const error = makeMessage(state.errorMessage, 'alert');
      const actions = document.createElement('span');
      actions.className = 'polaris-arquivos-actions';
      actions.append(
        makeAction(text.retry, 'polaris-arquivos-retry', `retry:${directory}`, () => {
          void load(directory, state.retryCursor, state.retryAppend);
        }, state.loading),
      );
      error.append(actions);
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
    const heading = document.createElement('h2');
    heading.className = 'sidebar-heading';
    heading.tabIndex = -1;
    heading.dataset.focusKey = 'heading';
    heading.textContent = text.title;
    section.append(heading);

    const rootList = document.createElement('ul');
    rootList.className = 'polaris-arquivos-tree';
    renderDirectory('', rootList);
    section.append(rootList);
    container.replaceChildren(section);

    if (focusedKey) {
      const focusTarget = [...container.querySelectorAll<HTMLElement>('[data-focus-key]')].find(
        (candidate) => candidate.dataset.focusKey === focusedKey,
      );
      (focusTarget ?? heading).focus({ preventScroll: true });
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

  render();
  void load('', null, false);

  return () => {
    if (disposed) return;
    disposed = true;
    requests.clear();
    container.replaceChildren();
  };
}
