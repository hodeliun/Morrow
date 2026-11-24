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
    expect(container.querySelector<HTMLButtonElement>('[data-focus-key="folder:Assets"]')?.textContent).toContain('Assets');
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

  it('offers explicit open and reveal actions for files and keeps the alternate action available after no association', async () => {
    const actOnFile = vi
      .fn()
      .mockResolvedValueOnce({ generation: 7, status: 'noAssociation' })
      .mockResolvedValueOnce({ generation: 7, status: 'revealed' });
    const listFilesPage = vi.fn(async () =>
      page('ready', [entry('Assets', 'Assets', 'folder'), entry('Report.docx', 'Report.docx')]),
    );
    const { container } = mount({ isActive: () => true, listFilesPage, actOnFile }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('Report.docx'));
    const open = container.querySelector<HTMLButtonElement>(
      '[data-focus-key="file-action:open:Report.docx"]',
    );
    const reveal = container.querySelector<HTMLButtonElement>(
      '[data-focus-key="file-action:reveal:Report.docx"]',
    );
    expect(open?.textContent).toBe('Report.docx');
    expect(open?.getAttribute('aria-label')).toBe('Open with the system app: Report.docx');
    expect(open?.type).toBe('button');
    expect(open?.tabIndex).toBe(0);
    expect(reveal?.getAttribute('aria-label')).toBe('Show in folder: Report.docx');
    expect(reveal?.type).toBe('button');
    expect(reveal?.tabIndex).toBe(0);
    expect(open?.closest('.polaris-arquivos-file-row')?.querySelectorAll('.polaris-arquivos-file-action'))
      .toHaveLength(2);
    expect(container.querySelector('[data-focus-key="file-action:open:Assets"]')).toBeNull();

    open!.focus();
    open!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('No system app is associated'));
    expect(actOnFile).toHaveBeenLastCalledWith('Report.docx', 7, 'open');
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe('file-action:open:Report.docx');
    expect(container.querySelector('[data-focus-key="file-action:reveal:Report.docx"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('[data-focus-key="file-action:reveal:Report.docx"]')!.focus();
    container.querySelector<HTMLButtonElement>('[data-focus-key="file-action:reveal:Report.docx"]')!.click();
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeNull());
    expect(actOnFile).toHaveBeenLastCalledWith('Report.docx', 7, 'reveal');
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe('file-action:reveal:Report.docx');
  });

  it('does not show file actions when the host has no catalog action capability', async () => {
    const listFilesPage = vi.fn(async () => page('ready', [entry('Report.docx', 'Report.docx')]));
    const { container } = mount({ isActive: () => true, listFilesPage });

    await vi.waitFor(() => expect(container.textContent).toContain('Report.docx'));
    expect(container.querySelector('.polaris-arquivos-file-action')).toBeNull();
  });

  it('reports a file removed after listing and refreshes that directory', async () => {
    const actOnFile = vi.fn(async () => ({ generation: 7, status: 'notFound' as const }));
    const listFilesPage = vi
      .fn(async () => page('ready', [entry('Gone.psd', 'Gone.psd')]))
      .mockResolvedValueOnce(page('ready', [entry('Gone.psd', 'Gone.psd')]))
      .mockResolvedValueOnce(page('empty'));
    const { container } = mount({ isActive: () => true, listFilesPage, actOnFile }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('Gone.psd'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="file-action:open:Gone.psd"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('no longer in the vault'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="refresh:"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('This folder is empty'));
    expect(listFilesPage).toHaveBeenCalledTimes(2);
    expect(actOnFile).toHaveBeenCalledWith('Gone.psd', 7, 'open');
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

  it('filters only presentation, keeps expanded/page state, and can restore the default', async () => {
    const readPreferences = vi.fn(() => ({
      status: 'ready' as const,
      value: {
        mode: 'selected',
        selectedExtensions: ['.PDF'],
        hiddenExtensions: [],
        customExtensions: [],
        includeExtensionless: false,
        showAttachments: false,
      },
    }));
    const writePreferences = vi.fn((_value: unknown | null) => ({ status: 'saved' as const }));
    const listFilesPage = vi.fn(async (directory: string, cursor: string | null = null, _limit = 200) => {
      if (directory === '' && cursor === null)
        return page('ready', [
          entry('Assets', 'Assets', 'folder'),
          entry('attachments', 'attachments', 'folder'),
          entry('manual.pdf', 'manual.pdf'),
          entry('picture.png', 'picture.png'),
          entry('README', 'README'),
        ], 'root-next');
      if (directory === '' && cursor === 'root-next')
        return page('ready', [entry('later.pdf', 'later.pdf'), entry('later.png', 'later.png')]);
      if (directory === 'Assets') return page('ready', [entry('child.pdf', 'Assets/child.pdf')]);
      if (directory === 'attachments') return page('ready', [entry('archive.pdf', 'attachments/archive.pdf')]);
      return page('empty');
    });
    const { container } = mount({ isActive: () => true, listFilesPage, readPreferences, writePreferences });

    await vi.waitFor(() => expect(container.textContent).toContain('manual.pdf'));
    expect(container.textContent).not.toContain('picture.png');
    expect(container.textContent).not.toContain('README');
    expect(container.querySelector('[data-focus-key="more:"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('[data-focus-key="folder:Assets"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('child.pdf'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(listFilesPage).toHaveBeenCalledWith('attachments', null, 200));
    await vi.waitFor(() => expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull());
    expect(container.querySelector<HTMLButtonElement>('[data-focus-key="folder:Assets"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).not.toContain('picture.png');

    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-reset"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('picture.png'));
    expect(writePreferences).toHaveBeenLastCalledWith(null);
    expect(container.querySelector<HTMLButtonElement>('[data-focus-key="folder:Assets"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-focus-key="more:"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>('[data-focus-key="more:"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('later.png'));
    expect(container.textContent).toContain('later.pdf');
    expect(container.textContent).toContain('child.pdf');
    expect(readPreferences).toHaveBeenCalledOnce();
  });

  it('hides the attachments folder from the first page before settings are opened', async () => {
    const readPreferences = vi.fn(() => ({ status: 'ready' as const, value: null }));
    const listFilesPage = vi.fn(async () =>
      page('ready', [entry('attachments', 'attachments', 'folder'), entry('notes.pdf', 'notes.pdf')]),
    );
    const { container } = mount({ isActive: () => true, listFilesPage, readPreferences });

    await vi.waitFor(() => expect(container.textContent).toContain('notes.pdf'));
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();
    expect(container.querySelector('.polaris-arquivos-settings')).toBeNull();
    expect(listFilesPage).toHaveBeenCalledOnce();
    expect(readPreferences).toHaveBeenCalledOnce();
  });

  it('keeps attachments hidden while discovery is pending and restores expansion when toggled back on', async () => {
    const scanPending = deferred<VaultFilePage>();
    let rootCalls = 0;
    const listFilesPage = vi.fn(async (directory: string) => {
      if (directory === '') {
        rootCalls += 1;
        if (rootCalls === 1)
          return page('ready', [entry('attachments', 'attachments', 'folder'), entry('notes.pdf', 'notes.pdf')]);
        return scanPending.promise;
      }
      if (directory === 'attachments')
        return page('ready', [entry('Nested', 'attachments/Nested', 'folder'), entry('photo.pdf', 'attachments/photo.pdf')]);
      return page('empty');
    });
    const { container } = mount({
      isActive: () => true,
      listFilesPage,
      readPreferences: () => ({ status: 'ready', value: null }),
      writePreferences: () => ({ status: 'saved' }),
    }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('notes.pdf'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Discovering extensions'));
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();

    const attachmentSwitch = () => container.querySelector<HTMLInputElement>('[data-focus-key="attachments"]')!;
    attachmentSwitch().click();
    const folder = container.querySelector<HTMLButtonElement>('[data-focus-key="folder:attachments"]');
    expect(folder).not.toBeNull();
    folder!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('photo.pdf'));
    expect(container.querySelector('[data-focus-key="folder:attachments/Nested"]')).not.toBeNull();

    attachmentSwitch().click();
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();
    attachmentSwitch().click();
    const restoredFolder = container.querySelector<HTMLButtonElement>('[data-focus-key="folder:attachments"]');
    expect(restoredFolder?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-focus-key="folder:attachments/Nested"]')).not.toBeNull();
    expect(container.textContent).toContain('photo.pdf');

    scanPending.resolve(page('ready', [entry('attachments', 'attachments', 'folder')]));
    await vi.waitFor(() => expect(container.textContent).not.toContain('Discovering extensions'));
  });

  it('hides attachments in partial discovery while retaining their discovered types and folder state', async () => {
    let rootCalls = 0;
    let attachmentCalls = 0;
    const listFilesPage = vi.fn(async (directory: string) => {
      if (directory === '') {
        rootCalls += 1;
        return page('ready', [
          entry('attachments', 'attachments', 'folder'),
          entry('Blocked', 'Blocked', 'folder'),
          ...(rootCalls === 1 ? [entry('notes.pdf', 'notes.pdf')] : []),
        ]);
      }
      if (directory === 'attachments') {
        attachmentCalls += 1;
        return attachmentCalls === 1
          ? page('ready', [entry('hidden.qzx', 'attachments/hidden.qzx')])
          : page('ready', [entry('Nested', 'attachments/Nested', 'folder'), entry('photo.pdf', 'attachments/photo.pdf')]);
      }
      if (directory === 'Blocked') return page('blocked');
      return page('empty');
    });
    const { container } = mount({
      isActive: () => true,
      listFilesPage,
      readPreferences: () => ({ status: 'ready', value: null }),
      writePreferences: () => ({ status: 'saved' }),
    }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('notes.pdf'));
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Some folders could not be checked'));
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();
    expect(container.querySelector('[aria-label="Show .qzx"]')).not.toBeNull();

    const attachmentSwitch = () => container.querySelector<HTMLInputElement>('[data-focus-key="attachments"]')!;
    attachmentSwitch().click();
    const folder = container.querySelector<HTMLButtonElement>('[data-focus-key="folder:attachments"]');
    expect(folder).not.toBeNull();
    folder!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('photo.pdf'));
    expect(container.querySelector('[data-focus-key="folder:attachments/Nested"]')).not.toBeNull();

    attachmentSwitch().click();
    expect(container.querySelector('[data-focus-key="folder:attachments"]')).toBeNull();
    attachmentSwitch().click();
    expect(container.querySelector<HTMLButtonElement>('[data-focus-key="folder:attachments"]')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-focus-key="folder:attachments/Nested"]')).not.toBeNull();
    expect(container.textContent).toContain('photo.pdf');
  });

  it('discovers nested types only when settings open, searches them, and adds a custom type immediately', async () => {
    const scanRoot = deferred<VaultFilePage>();
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const listFilesPage = vi.fn(async (directory: string, _cursor: string | null = null, _limit = 200) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (calls === 1) return page('ready', [entry('Cold', 'Cold', 'folder'), entry('manual.pdf', 'manual.pdf')]);
        if (calls === 2) return await scanRoot.promise;
        if (directory === 'Cold') return page('ready', [entry('rare.abcxyz', 'Cold/rare.abcxyz')]);
        return page('empty');
      } finally {
        inFlight -= 1;
      }
    });
    const writePreferences = vi.fn(() => ({ status: 'saved' as const }));
    const { container } = mount({
      isActive: () => true,
      listFilesPage,
      readPreferences: () => ({ status: 'ready', value: null }),
      writePreferences,
    }, 'en');

    await vi.waitFor(() => expect(container.textContent).toContain('manual.pdf'));
    expect(listFilesPage).toHaveBeenCalledTimes(1);
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Discovering extensions'));
    expect(listFilesPage).toHaveBeenCalledTimes(2);

    const extensionInput = container.querySelector<HTMLInputElement>('[data-focus-key="extension-add"]')!;
    extensionInput.value = '.qzx';
    extensionInput.dispatchEvent(new Event('input', { bubbles: true }));
    container.querySelector<HTMLButtonElement>('.polaris-arquivos-add-button')!.click();
    const firstSearch = container.querySelector<HTMLInputElement>('[data-focus-key="extension-search"]')!;
    firstSearch.value = 'qzx';
    firstSearch.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      const custom = container.querySelector<HTMLInputElement>('[aria-label="Show .qzx"]');
      expect(custom?.checked).toBe(true);
    });
    expect(writePreferences).toHaveBeenCalled();

    scanRoot.resolve(page('ready', [entry('Cold', 'Cold', 'folder'), entry('manual.pdf', 'manual.pdf')]));
    await vi.waitFor(() => expect(listFilesPage).toHaveBeenCalledWith('Cold', null, 200));
    await vi.waitFor(() => expect(container.textContent).not.toContain('Discovering extensions'));
    const search = container.querySelector<HTMLInputElement>('[data-focus-key="extension-search"]')!;
    search.value = 'abcxyz';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(container.querySelector('[aria-label="Show .abcxyz"]')).not.toBeNull());
    expect(container.querySelector('[data-focus-key="folder:Cold"]')).toBeNull();
    expect(maxInFlight).toBe(1);
  });

  it('restores saved filters when the plugin is mounted again', async () => {
    let stored: unknown | null = null;
    const readPreferences = vi.fn(() => ({ status: 'ready' as const, value: stored }));
    const writePreferences = vi.fn((value: unknown | null) => {
      stored = value;
      return { status: 'saved' as const };
    });
    const listFilesPage = vi.fn(async () => page('empty'));
    const host = { isActive: () => true, listFilesPage, readPreferences, writePreferences };
    const first = mount(host, 'en');
    await vi.waitFor(() => expect(first.container.textContent).toContain('This folder is empty'));
    first.container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    const add = first.container.querySelector<HTMLInputElement>('[data-focus-key="extension-add"]')!;
    add.value = '.qzx';
    add.dispatchEvent(new Event('input', { bubbles: true }));
    first.container.querySelector<HTMLButtonElement>('.polaris-arquivos-add-button')!.click();
    expect(stored).toMatchObject({ customExtensions: ['qzx'], selectedExtensions: expect.arrayContaining(['qzx']) });
    first.dispose();
    first.container.remove();

    const second = mount(host, 'en');
    await vi.waitFor(() => expect(second.container.textContent).toContain('This folder is empty'));
    second.container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    const search = second.container.querySelector<HTMLInputElement>('[data-focus-key="extension-search"]')!;
    search.value = 'qzx';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => {
      const custom = second.container.querySelector<HTMLInputElement>('[aria-label="Show .qzx"]');
      expect(custom?.checked).toBe(true);
    });
    expect(readPreferences).toHaveBeenCalledTimes(2);
  });

  it('cancels global discovery when the filter panel closes and guards repeated cursors', async () => {
    const pending = deferred<VaultFilePage>();
    let calls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const listFilesPage = vi.fn(async (_directory: string, _cursor: string | null = null, _limit = 200) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (calls === 1) return page('ready', [entry('Deep', 'Deep', 'folder')]);
        if (calls === 2) return await pending.promise;
        if (calls === 3) return page('ready', [entry('Deep', 'Deep', 'folder')]);
        return page('ready', [entry('late.qzx', 'Deep/late.qzx')]);
      } finally {
        inFlight -= 1;
      }
    });
    const { container } = mount({
      isActive: () => true,
      listFilesPage,
      readPreferences: () => ({
        status: 'ready',
        value: { mode: 'selected', selectedExtensions: ['qzx'], customExtensions: ['qzx'] },
      }),
    }, 'en');
    await vi.waitFor(() => expect(container.textContent).toContain('Deep'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(listFilesPage).toHaveBeenCalledTimes(2));
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-close"]')!.click();
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    expect(listFilesPage).toHaveBeenCalledTimes(2);
    pending.resolve(page('ready', [entry('Deep', 'Deep', 'folder')]));
    await vi.waitFor(() => expect(listFilesPage).toHaveBeenCalledTimes(4));
    await vi.waitFor(() => expect(container.textContent).not.toContain('Discovering extensions'));
    expect(maxInFlight).toBe(1);
    expect(container.querySelector('[data-focus-key="folder:Deep"]')).not.toBeNull();
  });

  it('stops a repeated metadata cursor and reports partial discovery', async () => {
    let rootCalls = 0;
    const listFilesPage = vi.fn(async (_directory: string, cursor: string | null = null, _limit = 200) => {
      if (cursor === null) {
        rootCalls += 1;
        return rootCalls === 1 ? page('ready') : page('ready', [], 'loop');
      }
      return page('ready', [], 'loop');
    });
    const { container } = mount({
      isActive: () => true,
      listFilesPage,
      readPreferences: () => ({ status: 'ready', value: null }),
    }, 'en');
    await vi.waitFor(() => expect(container.textContent).toContain('This folder is empty'));
    container.querySelector<HTMLButtonElement>('[data-focus-key="settings-toggle"]')!.click();
    await vi.waitFor(() => expect(container.textContent).toContain('Some folders could not be checked'));
    expect(listFilesPage).toHaveBeenCalledTimes(3);
  });
});
