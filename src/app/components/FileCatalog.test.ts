import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: { name: 'first' },
  openFile: vi.fn(),
  getVaultId: vi.fn(),
  openTab: vi.fn(),
  openBrowserUrl: vi.fn(),
  openRouteInPane: vi.fn(),
  getVisiblePanes: vi.fn(),
  notifyPaneLimitReached: vi.fn(),
  readDescriptor: vi.fn(),
}));
vi.mock('../workspace', () => ({ getSession: () => mocks.session, useFileCatalog: vi.fn() }));
vi.mock('../platform/desktop', () => ({
  desktop: { fileHandlers: { openFile: mocks.openFile }, imageViewer: { getVaultId: mocks.getVaultId }, browserTabs: { readDescriptor: mocks.readDescriptor } },
}));
vi.mock('../tabs', () => ({
  openTab: mocks.openTab,
  openBrowserUrl: mocks.openBrowserUrl,
  openRouteInPane: mocks.openRouteInPane,
  getVisiblePanes: mocks.getVisiblePanes,
  notifyPaneLimitReached: mocks.notifyPaneLimitReached,
  getTabs: () => ({ pane: 'morrow-pane-layout:pane:2' }),
}));
vi.mock('../i18n', () => ({ t: (key: string) => key, useTranslation: vi.fn() }));

import { openCatalogFile, openCatalogFileInPane } from './FileCatalog';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.session = { name: 'first' };
  mocks.openFile.mockReset().mockResolvedValue({ ok: true, destination: 'internal' });
  mocks.getVaultId.mockReset().mockResolvedValue({ ok: true, vaultId: '11111111-1111-4111-8111-111111111111' });
  mocks.openTab.mockReset();
  mocks.openBrowserUrl.mockReset();
  mocks.openRouteInPane.mockReset().mockReturnValue({ success: true });
  mocks.getVisiblePanes.mockReset().mockReturnValue([{ id: 'pane-1', tabId: 't1' }, { id: 'pane-2', tabId: null }]);
  mocks.notifyPaneLimitReached.mockReset();
  mocks.readDescriptor.mockReset();
});

it('opens a validated Google descriptor internally without dispatching its file to an external application', async () => {
  mocks.readDescriptor.mockResolvedValue(JSON.stringify({ url: 'https://docs.google.com/document/d/synthetic/edit' }));
  await openCatalogFile('Documents/synthetic.gdoc', false, 'en', vi.fn());
  expect(mocks.readDescriptor).toHaveBeenCalledExactlyOnceWith('Documents/synthetic.gdoc');
  expect(mocks.openBrowserUrl).toHaveBeenCalledExactlyOnceWith('https://docs.google.com/document/d/synthetic/edit');
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it('does not open a completed descriptor from a previous vault session', async () => {
  const pending = deferred<string>();
  mocks.readDescriptor.mockReturnValue(pending.promise);
  const failure = vi.fn();
  const opening = openCatalogFile('Documents/same.gsheet', false, 'en', failure);
  mocks.session = { name: 'second' };
  pending.resolve(JSON.stringify({ url: 'https://docs.google.com/spreadsheets/d/synthetic/edit' }));
  await opening;
  expect(mocks.openBrowserUrl).not.toHaveBeenCalled();
  expect(mocks.openFile).not.toHaveBeenCalled();
  expect(failure.mock.calls).toEqual([[null]]);
});

it('opens the selected image once while its session remains current', async () => {
  const failure = vi.fn();
  await openCatalogFile('Images/同じ image.png', false, 'en', failure);
  expect(mocks.openTab).toHaveBeenCalledExactlyOnceWith(
    '#/file/11111111-1111-4111-8111-111111111111/Images/%E5%90%8C%E3%81%98%20image.png',
  );
  expect(failure).toHaveBeenLastCalledWith(null);
});

it('does not request another vault identity after the handler resolves in a different session', async () => {
  const pending = deferred<{ ok: true; destination: 'internal' }>();
  mocks.openFile.mockReturnValue(pending.promise);
  const failure = vi.fn();
  const opening = openCatalogFile('Images/same.png', false, 'en', failure);
  mocks.session = { name: 'second' };
  pending.resolve({ ok: true, destination: 'internal' });
  await opening;
  expect(mocks.getVaultId).not.toHaveBeenCalled();
  expect(mocks.openTab).not.toHaveBeenCalled();
  expect(failure.mock.calls).toEqual([[null]]);
});

it('does not open the same path in a new vault after an identity request was pending', async () => {
  const pending = deferred<{ ok: true; vaultId: string }>();
  mocks.getVaultId.mockReturnValue(pending.promise);
  const failure = vi.fn();
  const opening = openCatalogFile('Images/same.png', false, 'en', failure);
  await vi.waitFor(() => expect(mocks.getVaultId).toHaveBeenCalledOnce());
  mocks.session = { name: 'second' };
  pending.resolve({ ok: true, vaultId: '22222222-2222-4222-8222-222222222222' });
  await opening;
  expect(mocks.openTab).not.toHaveBeenCalled();
  expect(failure.mock.calls).toEqual([[null]]);
});

it('does not report an obsolete handler error in the replacement session', async () => {
  const pending = deferred<never>();
  mocks.openFile.mockReturnValue(pending.promise);
  const failure = vi.fn();
  const opening = openCatalogFile('Images/same.png', false, 'en', failure);
  mocks.session = { name: 'second' };
  pending.reject(new Error('synthetic handler failure'));
  await opening;
  expect(mocks.openTab).not.toHaveBeenCalled();
  expect(failure.mock.calls).toEqual([[null]]);
});

it('places a catalog file in a specific pane or splits on an edge when under 4 panes, rejecting the 5th pane', async () => {
  const resCenter = await openCatalogFileInPane('Docs/Guide.pdf', 'pane-2');
  expect(resCenter).toEqual({ success: true });
  expect(mocks.openRouteInPane).toHaveBeenCalledExactlyOnceWith(
    '#/file/11111111-1111-4111-8111-111111111111/Docs/Guide.pdf',
    'pane-2',
    undefined,
  );

  mocks.openRouteInPane.mockClear();
  const resEdge = await openCatalogFileInPane('Docs/Guide.pdf', 'pane-1', 'right');
  expect(resEdge).toEqual({ success: true });
  expect(mocks.openRouteInPane).toHaveBeenCalledExactlyOnceWith(
    '#/file/11111111-1111-4111-8111-111111111111/Docs/Guide.pdf',
    'pane-1',
    { splitEdge: 'right' },
  );

  mocks.openRouteInPane.mockClear();
  mocks.getVisiblePanes.mockReturnValue([
    { id: 'pane-1', tabId: 't1' },
    { id: 'pane-2', tabId: 't2' },
    { id: 'pane-3', tabId: 't3' },
    { id: 'pane-4', tabId: 't4' },
  ]);
  const resFifth = await openCatalogFileInPane('Docs/Guide.pdf', 'pane-1', 'bottom');
  expect(resFifth).toEqual({ success: false, reason: 'too-many-panes' });
  expect(mocks.notifyPaneLimitReached).toHaveBeenCalledOnce();
  expect(mocks.openRouteInPane).not.toHaveBeenCalled();
});
