// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultFileMetadata, VaultFilePage } from '../../../../src/app/platform/desktop';
import type { PluginSidebarFileCatalogHost } from '../../../../src/app/plugins/registry';
import { mountFileCatalog } from './catalog';

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function entry(name: string, path: string, kind: 'file' | 'folder' = 'file'): VaultFileMetadata {
  return { name, path, kind, size: kind === 'file' ? 12 : null, modified: null };
}

function page(
  status: VaultFilePage['status'],
  entries: VaultFileMetadata[] = [],
  nextCursor: string | null = null,
  error: string | null = null,
): VaultFilePage {
  return { generation: 7, status, entries, nextCursor, error };
}

function mount(host: PluginSidebarFileCatalogHost, locale: 'en' | 'es' | 'pt' = 'pt') {
  const container = document.createElement('div');
  document.body.append(container);
  const dispose = mountFileCatalog(container, host, locale);
  disposers.push(() => {
    dispose();
    container.remove();
  });
  return { container, dispose };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Polaris Arquivos sidebar catalog', () => {
  it('expands folders, loads another page, and preserves focus while the tree changes', async () => {
    const listFilesPage = vi.fn(async (directory: string, cursor: string | null = null, _limit = 200) => {
      if (directory === '' && cursor === null)
        return page('ready', [entry('Assets', 'Assets', 'folder'), entry('cover.pdf', 'cover.pdf')], 'root-next');
      if (directory === 'Assets') return page('ready', [entry('photo.png', 'Assets/photo.png')]);
      if (directory === '' && cursor === 'root-next')
        return page('ready', [entry('notes.zip', 'notes.zip')]);
      return page('blocked');
    });
    const { container } = mount({ isActive: () => true, listFilesPage });

    await vi.waitFor(() => expect(container.textContent).toContain('cover.pdf'));
    expect(container.querySelector('button')?.textContent).toContain('Assets');
    expect(container.querySelector('.polaris-arquivos-file-name')?.textContent).toBe('cover.pdf');

    const folder = container.querySelector<HTMLButtonElement>('[data-focus-key="folder:Assets"]');
    expect(folder).not.toBeNull();
    folder!.focus();
    folder!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('photo.png'));
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe('folder:Assets');
    const expandedFolder = container.querySelector('[data-focus-key="folder:Assets"]');
    expect(expandedFolder?.closest('li')?.querySelector(':scope > ul')?.textContent).toContain('photo.png');
    expect(listFilesPage).toHaveBeenCalledWith('Assets', null, 200);

    const more = container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]');
    expect(more).not.toBeNull();
    more!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('notes.zip'));
    expect(listFilesPage).toHaveBeenCalledWith('', 'root-next', 200);
  });

  it('keeps the load-more action keyboard-focusable while loading and restores focus when pagination ends', async () => {
    const nextPage = deferred<VaultFilePage>();
    const lastPage = deferred<VaultFilePage>();
    const listFilesPage = vi
      .fn(async (_directory: string, cursor: string | null = null, _limit = 200): Promise<VaultFilePage> => {
        if (cursor === null) return page('ready', [entry('first.pdf', 'first.pdf')], 'next');
        if (cursor === 'next') return nextPage.promise;
        return lastPage.promise;
      });
    const { container } = mount({ isActive: () => true, listFilesPage }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('first.pdf'));
    const firstAction = container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]');
    firstAction!.focus();
    firstAction!.click();

    let loadingAction = container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]');
    expect(loadingAction).not.toBeNull();
    expect(loadingAction!.disabled).toBe(false);
    expect(loadingAction!.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(loadingAction);
    loadingAction!.click();
    expect(listFilesPage).toHaveBeenCalledTimes(2);

    nextPage.resolve(page('ready', [entry('second.pdf', 'second.pdf')], 'last'));
    await vi.waitFor(() => expect(container.textContent).toContain('second.pdf'));
    const nextAction = container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]');
    expect(document.activeElement).toBe(nextAction);
    nextAction!.click();

    loadingAction = container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]');
    expect(loadingAction?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(loadingAction);
    lastPage.resolve(page('ready', [entry('third.pdf', 'third.pdf')]));
    await vi.waitFor(() => expect(container.textContent).toContain('third.pdf'));
    expect(container.querySelector('[data-focus-key="more:"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-focus-key="heading"]'));
  });

  it('keeps retry focused while its request is pending and after another error', async () => {
    const retryPage = deferred<VaultFilePage>();
    const finalPage = deferred<VaultFilePage>();
    const listFilesPage = vi
      .fn(async (_directory: string, _cursor: string | null = null, _limit = 200): Promise<VaultFilePage> =>
        page('ioError'),
      )
      .mockResolvedValueOnce(page('ioError'))
      .mockImplementationOnce(() => retryPage.promise)
      .mockImplementationOnce(() => finalPage.promise);
    const { container } = mount({ isActive: () => true, listFilesPage }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('could not be read'));
    const firstRetry = container.querySelector<HTMLButtonElement>('.polaris-arquivos-retry')!;
    firstRetry.focus();
    firstRetry.click();

    let retry = container.querySelector<HTMLButtonElement>('.polaris-arquivos-retry');
    expect(retry?.disabled).toBe(false);
    expect(retry?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(retry);
    retry!.click();
    expect(listFilesPage).toHaveBeenCalledTimes(2);

    retryPage.resolve(page('ioError'));
    await vi.waitFor(() => {
      retry = container.querySelector<HTMLButtonElement>('.polaris-arquivos-retry');
      expect(retry?.getAttribute('aria-disabled')).toBe('false');
    });
    expect(document.activeElement).toBe(retry);
    retry!.click();
    expect(document.activeElement?.getAttribute('aria-disabled')).toBe('true');
    finalPage.resolve(page('empty'));
    await vi.waitFor(() => expect(container.textContent).toContain('This folder is empty'));
    expect(container.querySelector('.polaris-arquivos-retry')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-focus-key="heading"]'));
  });

  it('shows a retry after a page error and then shows the empty-folder state', async () => {
    const listFilesPage = vi
      .fn(async (_directory: string, _cursor: string | null = null, _limit = 200): Promise<VaultFilePage> =>
        page('ioError'),
      )
      .mockResolvedValueOnce(page('ioError'))
      .mockResolvedValueOnce(page('empty'));
    const { container } = mount({ isActive: () => true, listFilesPage }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('could not be read'));
    const retry = container.querySelector<HTMLButtonElement>('.polaris-arquivos-retry');
    expect(retry?.textContent).toBe('Try again');
    retry!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('This folder is empty'));
    expect(listFilesPage).toHaveBeenCalledTimes(2);
  });

  it('renders an unavailable state when the host capability is null', async () => {
    const { container } = mount({ isActive: () => true });

    await vi.waitFor(() => expect(container.textContent).toContain('O catálogo de arquivos está indisponível'));
    expect(container.querySelector('.polaris-arquivos-retry')).not.toBeNull();
  });

  it('discards a pending response after the owning mount is revoked', async () => {
    let resolve!: (value: VaultFilePage) => void;
    const pending = new Promise<VaultFilePage>((done) => {
      resolve = done;
    });
    let active = true;
    const listFilesPage = vi.fn(() => pending);
    const { container, dispose } = mount({ isActive: () => active, listFilesPage });
    await settle();

    active = false;
    dispose();
    resolve(page('ready', [entry('stale.pdf', 'stale.pdf')]));
    await settle();

    expect(container.textContent).toBe('');
    expect(container.querySelector('section')).toBeNull();
  });
});
