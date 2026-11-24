// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as PluginLoader from './index';
import type * as PluginRegistry from './registry';
import type * as PluginProviders from './providerRegistry';
import type * as Preferences from '../platform/preferences';
import type { WorkspaceSession } from '../../storage/session';
import type { VaultCatalogFileActionResult, VaultFilePage } from '../platform/desktop';

const SETTINGS_FILE = '.morrow/plugins.json';
const PLUGINS_FOLDER = '.morrow/plugins';
const MAIN_FILE = `${PLUGINS_FOLDER}/fixture/main.js`;
const PREFERENCES_KEY = 'morrow.preferences';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type PluginGlobals = typeof globalThis & {
  __morrowActivationGate?: Promise<void>;
  __morrowActivationStarted?: () => void;
  __morrowActivationCount?: number;
  __morrowCleanupCount?: number;
  __morrowOldGate?: Promise<void>;
  __morrowOldStarted?: () => void;
  __morrowNewStarted?: () => void;
  __morrowOldCleanupCount?: number;
  __morrowCurrentStarted?: () => void;
  __morrowFirstGate?: Promise<void>;
  __morrowFirstStarted?: () => void;
  __morrowOtherActivationCount?: number;
  __morrowOldApi?: unknown;
  __morrowEnabledActivationCount?: number;
  __morrowReentrantCleanupCount?: number;
  __morrowReenterStop?: () => void;
};

function pluginGlobals(): PluginGlobals {
  return globalThis as PluginGlobals;
}

function installPluginModuleUrls() {
  const NativeBlob = globalThis.Blob;
  const NativeURL = globalThis.URL;
  let nextModule = 0;

  class FixtureBlob extends NativeBlob {
    readonly source: string;

    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      this.source = parts.map((part) => (typeof part === 'string' ? part : '')).join('');
    }
  }

  const objectUrls: string[] = [];
  const createObjectURL = vi.fn((blob: FixtureBlob) => {
    const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(blob.source)}#fixture-${nextModule++}`;
    objectUrls.push(url);
    return url;
  });
  const revokeObjectURL = vi.fn();
  const FixtureURL = class extends NativeURL {};
  Object.defineProperties(FixtureURL, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });

  vi.stubGlobal('Blob', FixtureBlob);
  vi.stubGlobal('URL', FixtureURL);
  return { objectUrls, createObjectURL, revokeObjectURL };
}

interface Harness {
  files: Map<string, string>;
  readText: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  listFilesPage: ReturnType<typeof vi.fn>;
  catalogFileAction: ReturnType<typeof vi.fn>;
  delayRead(path: string, promise: Promise<string | null>, started?: () => void): void;
  clearReadDelay(path: string): void;
  loader: typeof PluginLoader;
  registry: typeof PluginRegistry;
  providers: typeof PluginProviders;
  preferences: typeof Preferences;
  session: WorkspaceSession;
  databaseName: string;
  objectUrls: string[];
}

let harness: Harness | undefined;
let priorMorrow: Window['morrow'];
let priorPreferences: string | null;
let databaseSequence = 0;

async function createHarness(
  options: { enabled?: string[]; code?: string; pluginId?: string } = {},
): Promise<Harness> {
  vi.resetModules();
  priorMorrow = window.morrow;
  priorPreferences = localStorage.getItem(PREFERENCES_KEY);
  const pluginId = options.pluginId ?? 'fixture';
  const pluginFolder = `${PLUGINS_FOLDER}/${pluginId}`;

  const files = new Map<string, string>([
    [SETTINGS_FILE, JSON.stringify({ enabled: options.enabled ?? [] })],
    [
      `${pluginFolder}/manifest.json`,
      JSON.stringify({
        id: pluginId,
        name: 'Synthetic lifecycle fixture',
        version: '1.0.0',
        description: 'Local test fixture.',
        author: 'Test',
      }),
    ],
    [`${pluginFolder}/main.js`, options.code ?? 'export default () => {};'],
  ]);
  const delayedReads = new Map<string, { promise: Promise<string | null>; started?: () => void }>();
  const readText = vi.fn((path: string) => {
    const delayed = delayedReads.get(path);
    if (delayed) {
      delayed.started?.();
      return delayed.promise;
    }
    return Promise.resolve(files.get(path) ?? null);
  });
  const apply = vi.fn(async (operations: unknown) => {
    const results = (operations as Array<{ op: string; path: string; text?: string }>).map((operation) => {
      if (operation.op !== 'write' || typeof operation.text !== 'string')
        return { ok: false, message: 'Unsupported fixture operation.' };
      files.set(operation.path, operation.text);
      return { ok: true };
    });
    return results;
  });
  const listFilesPage = vi.fn(
    async (_directory: string, _cursor: string | null = null, _limit = 200): Promise<VaultFilePage> => ({
      generation: 1,
      status: 'empty',
      entries: [],
      nextCursor: null,
      error: null,
    }),
  );
  const catalogFileAction = vi.fn(
    async (_path: string, generation: number, action: 'open' | 'reveal'): Promise<VaultCatalogFileActionResult> => ({
      generation,
      status: action === 'open' ? 'opened' : 'revealed',
    }),
  );
  const vault = {
    readText,
    apply,
    exists: vi.fn(
      async (path: string) =>
        path === PLUGINS_FOLDER || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
    ),
    list: vi.fn(async (path: string) =>
      [...files.keys()]
        .filter((file) => file.startsWith(`${path}/`))
        .map((file) => ({ path: file, size: files.get(file)?.length ?? 0, mtime: 0 })),
    ),
    listFilesPage,
    catalogFileAction,
  };
  window.morrow = {
    platform: 'linux',
    version: 'test',
    dataPath: '/synthetic',
    vault,
  } as unknown as NonNullable<Window['morrow']>;
  const moduleUrls = installPluginModuleUrls();

  const preferences = await import('../platform/preferences');
  preferences.setPreferences({ plugins: true });
  const { openRepository } = await import('../../storage/repository');
  const { WorkspaceSession } = await import('../../storage/session');
  const opened = await WorkspaceSession.open(await openRepository(`plugin-loader-${databaseSequence++}`));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const workspace = await import('../workspace');
  workspace.setSession(session);

  harness = {
    files,
    readText,
    apply,
    listFilesPage,
    catalogFileAction,
    delayRead(path, promise, started) {
      delayedReads.set(path, { promise, started });
    },
    clearReadDelay(path) {
      delayedReads.delete(path);
    },
    loader: await import('./index'),
    registry: await import('./registry'),
    providers: await import('./providerRegistry'),
    preferences,
    session,
    databaseName: `plugin-loader-${databaseSequence - 1}`,
    objectUrls: moduleUrls.objectUrls,
  };
  return harness;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

afterEach(async () => {
  harness?.loader.stopPlugins();
  if (harness && !harness.session.isClosed) await harness.session.close();
  if (harness) await deleteDatabase(harness.databaseName);
  harness = undefined;
  for (const key of [
    '__morrowActivationGate',
    '__morrowActivationStarted',
    '__morrowActivationCount',
    '__morrowCleanupCount',
    '__morrowOldGate',
    '__morrowOldStarted',
    '__morrowNewStarted',
    '__morrowOldCleanupCount',
    '__morrowCurrentStarted',
    '__morrowFirstGate',
    '__morrowFirstStarted',
    '__morrowOtherActivationCount',
    '__morrowOldApi',
    '__morrowEnabledActivationCount',
    '__morrowReentrantCleanupCount',
    '__morrowReenterStop',
  ])
    Reflect.deleteProperty(globalThis, key);
  vi.unstubAllGlobals();
  window.morrow = priorMorrow;
  if (priorPreferences === null) localStorage.removeItem(PREFERENCES_KEY);
  else localStorage.setItem(PREFERENCES_KEY, priorPreferences);
  vi.restoreAllMocks();
});

describe('plugin loader lifecycle', () => {
  it('exposes the inline formula presentation to Polaris Dados and removes it on disable', async () => {
    const h = await createHarness({
      pluginId: 'polaris-dados',
      enabled: ['polaris-dados'],
      code: `export default (morrow) => {
        if (morrow.inlineFormulas.version !== 1) throw new Error('inline formula API version missing');
        morrow.inlineFormulas.registerPresentation((container, context) => {
          container.textContent = context.formula;
          return () => { container.textContent = context.fallback; };
        });
      };`,
    });
    await h.loader.startPlugins();

    const registration = h.registry.polarisDadosInlineFormulaPresentation();
    expect(registration?.owner).toBe('polaris-dados');
    expect(registration?.isActive()).toBe(true);
    const container = document.createElement('span');
    registration?.mount(container, {
      formula: '1 + 2',
      outputType: 'auto',
      format: {},
      fallback: 'Original',
      locale: 'pt',
    });
    expect(container.textContent).toBe('1 + 2');

    await h.loader.setPluginEnabled('polaris-dados', false);
    expect(registration?.isActive()).toBe(false);
    expect(h.registry.polarisDadosInlineFormulaPresentation()).toBeNull();
  });

  it('registers the Dados formula slash action only while that plugin activation is live', async () => {
    const h = await createHarness({
      pluginId: 'polaris-dados',
      enabled: ['polaris-dados'],
      code: `export default (morrow) => {
        morrow.inlineFormulas.addSlashCommand({
          title: 'Formula result',
          description: 'Insert a calculated result',
          keywords: 'formula result',
          onInvoke() {},
        });
      };`,
    });
    await h.loader.startPlugins();

    const slash = await import('../editor/SlashCommand');
    const registered = h.registry.pluginBlocks().find((item) => item.id === 'plugin:polaris-dados:inline-formula-1');
    expect(registered).toMatchObject({ title: 'Formula result' });
    expect(slash.getLocalizedBlocks().some((item) => item.id === registered?.id)).toBe(true);

    await h.loader.setPluginEnabled('polaris-dados', false);
    expect(h.registry.pluginBlocks().some((item) => item.id === registered?.id)).toBe(false);
    expect(slash.getLocalizedBlocks().some((item) => item.id === registered?.id)).toBe(false);
  });

  it('exposes the note-style mount only to Documento and cleans its registration on disable', async () => {
    const h = await createHarness({
      pluginId: 'polaris-documento',
      enabled: ['polaris-documento'],
      code: `export default (morrow) => {
        morrow.pages.noteStylePanel.add((container) => {
          container.textContent = 'Documento panel';
          return () => { container.textContent = ''; };
        });
      };`,
    });
    await h.loader.startPlugins();

    const registration = h.registry.documentoNoteStylePanel();
    expect(registration?.owner).toBe('polaris-documento');
    expect(registration?.isActive()).toBe(true);
    expect(registration?.mount).toBeTypeOf('function');

    await h.loader.setPluginEnabled('polaris-documento', false);
    expect(registration?.isActive()).toBe(false);
    expect(h.registry.documentoNoteStylePanel()).toBeNull();
  });

  it('revokes pending file pages on reload and binds the same relative path to the next workspace session', async () => {
    const h = await createHarness({
      pluginId: 'polaris-arquivos',
      enabled: ['polaris-arquivos'],
      code: 'export default (morrow) => morrow.sidebar.fileCatalog.add(() => {});',
    });
    await h.loader.startPlugins();
    const first = h.registry.polarisArquivosSidebarFileCatalog();
    expect(first?.isActive()).toBe(true);

    const firstGate = deferred<VaultFilePage>();
    const firstActionGate = deferred<VaultCatalogFileActionResult>();
    h.listFilesPage.mockReturnValueOnce(firstGate.promise);
    h.catalogFileAction.mockReturnValueOnce(firstActionGate.promise);
    const oldDuringReload = first!.host.listFilesPage!('Media', null, 999);
    const oldActionDuringReload = first!.host.actOnFile!('Media/same.docx', 1, 'open');
    expect(h.listFilesPage).toHaveBeenLastCalledWith('Media', null, 200);
    expect(h.catalogFileAction).toHaveBeenLastCalledWith('Media/same.docx', 1, 'open');
    await h.loader.reloadPlugin('polaris-arquivos');
    const second = h.registry.polarisArquivosSidebarFileCatalog();
    expect(first?.isActive()).toBe(false);
    expect(second?.isActive()).toBe(true);
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    h.listFilesPage.mockResolvedValueOnce({
      generation: 2,
      status: 'ready',
      entries: [{ name: 'same.pdf', path: 'Media/same.pdf', kind: 'file', size: 2, modified: null }],
      nextCursor: null,
      error: null,
    });
    const reloadedPage = await second!.host.listFilesPage!('Media', null, 200);
    expect(reloadedPage.generation).toBe(2);
    expect(reloadedPage.entries[0]?.path).toBe('Media/same.pdf');
    await expect(second!.host.actOnFile!('Media/same.pdf', 2, 'reveal')).resolves.toMatchObject({
      generation: 2,
      status: 'revealed',
    });
    expect(h.catalogFileAction).toHaveBeenLastCalledWith('Media/same.pdf', 2, 'reveal');

    const switchGate = deferred<VaultFilePage>();
    const switchActionGate = deferred<VaultCatalogFileActionResult>();
    h.listFilesPage.mockReturnValueOnce(switchGate.promise);
    h.catalogFileAction.mockReturnValueOnce(switchActionGate.promise);
    const oldDuringSwitch = second!.host.listFilesPage!('Media', null, 200);
    const oldActionDuringSwitch = second!.host.actOnFile!('Media/same.pdf', 2, 'open');
    const { openRepository } = await import('../../storage/repository');
    const { WorkspaceSession } = await import('../../storage/session');
    const nextDatabase = `plugin-loader-next-vault-${databaseSequence++}`;
    const nextOpen = await WorkspaceSession.open(await openRepository(nextDatabase));
    if (!nextOpen.ok) throw new Error(nextOpen.error);
    const nextSession = nextOpen.value;
    const workspace = await import('../workspace');
    workspace.setSession(nextSession);
    expect(second?.isActive()).toBe(false);
    expect(h.registry.polarisArquivosSidebarFileCatalog()).toBeNull();

    h.loader.stopPlugins();
    await h.loader.startPlugins();
    const third = h.registry.polarisArquivosSidebarFileCatalog();
    expect(third?.isActive()).toBe(true);
    h.listFilesPage.mockResolvedValueOnce({
      generation: 3,
      status: 'ready',
      entries: [{ name: 'same.pdf', path: 'Media/same.pdf', kind: 'file', size: 3, modified: null }],
      nextCursor: null,
      error: null,
    });
    const nextVaultPage = await third!.host.listFilesPage!('Media', null, 200);
    expect(nextVaultPage.generation).toBe(3);
    expect(nextVaultPage.entries[0]?.path).toBe('Media/same.pdf');

    firstGate.resolve({
      generation: 1,
      status: 'ready',
      entries: [{ name: 'same.pdf', path: 'Media/same.pdf', kind: 'file', size: 1, modified: null }],
      nextCursor: null,
      error: null,
    });
    switchGate.resolve({
      generation: 2,
      status: 'ready',
      entries: [{ name: 'same.pdf', path: 'Media/same.pdf', kind: 'file', size: 2, modified: null }],
      nextCursor: null,
      error: null,
    });
    switchActionGate.resolve({ generation: 2, status: 'opened' });
    expect((await oldDuringReload).status).toBe('stale');
    firstActionGate.resolve({ generation: 1, status: 'opened' });
    expect((await oldActionDuringReload).status).toBe('stale');
    expect((await oldDuringSwitch).status).toBe('stale');
    expect((await oldActionDuringSwitch).status).toBe('stale');

    await h.session.close();
    await nextSession.close();
    await deleteDatabase(nextDatabase);
  });

  it('deduplicates startup before settings I/O and ignores a stopped pending startup', async () => {
    const h = await createHarness({ enabled: ['fixture'], code: 'export default () => {};' });
    const settingsRead = deferred<string | null>();
    const settingsStarted = deferred<void>();
    h.delayRead(SETTINGS_FILE, settingsRead.promise, () => settingsStarted.resolve());

    const firstStart = h.loader.startPlugins();
    const duplicateStart = h.loader.startPlugins();
    await settingsStarted.promise;

    expect(duplicateStart).toBe(firstStart);
    expect(h.readText.mock.calls.filter(([path]) => path === SETTINGS_FILE)).toHaveLength(1);
    h.loader.stopPlugins();
    settingsRead.resolve(JSON.stringify({ enabled: ['fixture'] }));
    await Promise.all([firstStart, duplicateStart]);

    expect(h.readText).not.toHaveBeenCalledWith(MAIN_FILE);
    expect(h.objectUrls).toEqual([]);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(h.providers.getDatabaseProvider('fixture-provider')).toBeNull();
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: null },
    ]);
  });

  it('invalidates a main.js read as soon as disable is requested', async () => {
    const h = await createHarness({ enabled: ['fixture'], code: 'export default () => {};' });
    const sourceRead = deferred<string | null>();
    const sourceStarted = deferred<void>();
    h.delayRead(MAIN_FILE, sourceRead.promise, () => sourceStarted.resolve());

    const startup = h.loader.startPlugins();
    await sourceStarted.promise;
    const settingsRead = deferred<string | null>();
    const settingsStarted = deferred<void>();
    h.delayRead(SETTINGS_FILE, settingsRead.promise, () => settingsStarted.resolve());
    const disabled = h.loader.setPluginEnabled('fixture', false);
    await settingsStarted.promise;
    sourceRead.resolve('export default () => { throw new Error("must not activate"); };');
    await startup;
    const restart = h.loader.startPlugins();
    settingsRead.resolve(JSON.stringify({ enabled: ['fixture'] }));
    h.clearReadDelay(SETTINGS_FILE);
    await Promise.all([disabled, restart]);

    expect(h.objectUrls).toEqual([]);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(h.providers.getDatabaseProvider('fixture-provider')).toBeNull();
    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toEqual({ enabled: [] });
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: false, loaded: false, error: null },
    ]);
  });

  it('continues the startup batch for unrelated enabled plugins after one ID is disabled', async () => {
    const h = await createHarness({
      enabled: ['fixture', 'other'],
      code: 'export default () => { throw new Error("must not activate"); };',
    });
    h.files.set(
      `${PLUGINS_FOLDER}/other/manifest.json`,
      JSON.stringify({
        id: 'other',
        name: 'Other synthetic fixture',
        version: '1.0.0',
        description: 'Local test fixture.',
        author: 'Test',
      }),
    );
    h.files.set(
      `${PLUGINS_FOLDER}/other/main.js`,
      `export default (morrow) => {
        globalThis.__morrowOtherActivationCount++;
        morrow.commands.add({ id: 'other', name: 'Other', run: () => {} });
      };`,
    );
    const sourceRead = deferred<string | null>();
    const sourceStarted = deferred<void>();
    h.delayRead(MAIN_FILE, sourceRead.promise, () => sourceStarted.resolve());
    pluginGlobals().__morrowOtherActivationCount = 0;

    const startup = h.loader.startPlugins();
    await sourceStarted.promise;
    await h.loader.setPluginEnabled('fixture', false);
    sourceRead.resolve('export default () => { throw new Error("must not activate"); };');
    await startup;

    expect(pluginGlobals().__morrowOtherActivationCount).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.id)).toEqual(['plugin:other:other']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: false, loaded: false, error: null },
      { id: 'other', enabled: true, loaded: true, error: null },
    ]);
  });

  it('reconciles a persisted enable with the fresh startup after stop while preserving unrelated plugins', async () => {
    const h = await createHarness({
      enabled: ['other'],
      code: 'export default () => { globalThis.__morrowEnabledActivationCount++; };',
    });
    h.files.set(
      `${PLUGINS_FOLDER}/other/manifest.json`,
      JSON.stringify({ id: 'other', name: 'Other', version: '1.0.0', description: '', author: 'Test' }),
    );
    h.files.set(
      `${PLUGINS_FOLDER}/other/main.js`,
      'export default () => { globalThis.__morrowOtherActivationCount++; };',
    );
    pluginGlobals().__morrowEnabledActivationCount = 0;
    pluginGlobals().__morrowOtherActivationCount = 0;

    const writeStarted = deferred<void>();
    const writeGate = deferred<void>();
    h.apply.mockImplementationOnce(async (operations) => {
      const result = (operations as Array<{ op: string; path: string; text?: string }>).map((operation) => {
        if (operation.op !== 'write' || typeof operation.text !== 'string')
          return { ok: false, message: 'Unsupported fixture operation.' };
        h.files.set(operation.path, operation.text);
        return { ok: true };
      });
      writeStarted.resolve();
      await writeGate.promise;
      return result;
    });

    const enabling = h.loader.setPluginEnabled('fixture', true);
    await writeStarted.promise;
    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toMatchObject({ enabled: ['fixture', 'other'] });

    h.preferences.setPreferences({ plugins: false });
    h.loader.stopPlugins();
    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();

    expect(pluginGlobals().__morrowEnabledActivationCount).toBe(0);
    expect(pluginGlobals().__morrowOtherActivationCount).toBe(1);

    writeGate.resolve();
    await enabling;

    expect(pluginGlobals().__morrowEnabledActivationCount).toBe(1);
    expect(pluginGlobals().__morrowOtherActivationCount).toBe(1);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
      { id: 'other', enabled: true, loaded: true, error: null },
    ]);
  });

  it('restarts a persisted enable in the fresh lifecycle while its earlier activation is held', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__morrowActivationCount++;
        const generation = globalThis.__morrowActivationCount;
        morrow.commands.add({ id: 'shared', name: 'Instance ' + generation, run: () => {} });
        if (generation === 1) {
          globalThis.__morrowOldStarted();
          await globalThis.__morrowOldGate;
          return () => { globalThis.__morrowOldCleanupCount++; };
        }
        globalThis.__morrowNewStarted();
      };`,
    });
    const oldStarted = deferred<void>();
    const oldGate = deferred<void>();
    const newStarted = deferred<void>();
    pluginGlobals().__morrowActivationCount = 0;
    pluginGlobals().__morrowOldCleanupCount = 0;
    pluginGlobals().__morrowOldStarted = () => oldStarted.resolve();
    pluginGlobals().__morrowOldGate = oldGate.promise;
    pluginGlobals().__morrowNewStarted = () => newStarted.resolve();

    const enabling = h.loader.setPluginEnabled('fixture', true);
    await oldStarted.promise;
    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toMatchObject({ enabled: ['fixture'] });

    h.preferences.setPreferences({ plugins: false });
    h.loader.stopPlugins();
    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();
    await newStarted.promise;

    expect(pluginGlobals().__morrowActivationCount).toBe(2);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Instance 2']);

    oldGate.resolve();
    await enabling;

    expect(pluginGlobals().__morrowOldCleanupCount).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Instance 2']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('restores persisted enabled state after a held disable write fails during a fresh start', async () => {
    const h = await createHarness({
      enabled: ['fixture'],
      code: `export default (morrow) => {
        globalThis.__morrowActivationCount++;
        morrow.commands.add({
          id: 'instance',
          name: 'Instance ' + globalThis.__morrowActivationCount,
          run: () => {},
        });
      };`,
    });
    pluginGlobals().__morrowActivationCount = 0;
    await h.loader.startPlugins();
    expect(pluginGlobals().__morrowActivationCount).toBe(1);

    const writeStarted = deferred<void>();
    const writeGate = deferred<void>();
    h.apply.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await writeGate.promise;
      return [{ ok: false, message: 'synthetic disable write failure' }];
    });
    const disabling = h.loader.setPluginEnabled('fixture', false);
    await writeStarted.promise;

    h.preferences.setPreferences({ plugins: false });
    h.loader.stopPlugins();
    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();
    expect(pluginGlobals().__morrowActivationCount).toBe(1);

    writeGate.resolve();
    await expect(disabling).rejects.toThrow('synthetic disable write failure');

    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toMatchObject({ enabled: ['fixture'] });
    expect(pluginGlobals().__morrowActivationCount).toBe(2);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Instance 2']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('does not publish an activation error when cleanup synchronously stops its generation', async () => {
    const h = await createHarness({
      code: `export default (morrow) => {
        morrow.register(() => {
          globalThis.__morrowReentrantCleanupCount++;
          globalThis.__morrowReenterStop();
        });
        throw new Error('stale activation error');
      };`,
    });
    pluginGlobals().__morrowReentrantCleanupCount = 0;
    pluginGlobals().__morrowReenterStop = () => h.loader.stopPlugins();

    await h.loader.setPluginEnabled('fixture', true);

    expect(pluginGlobals().__morrowReentrantCleanupCount).toBe(1);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: null },
    ]);
  });

  it('revokes captured API calls and disposes late activation cleanup once after disable', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__morrowOldApi = morrow;
        const remove = morrow.commands.add({ id: 'early', name: 'Early', run: () => {} });
        morrow.providers.register({ id: 'fixture-provider', apiVersion: 1, mount: () => {} });
        globalThis.__morrowActivationStarted();
        await globalThis.__morrowActivationGate;
        try { morrow.commands.add({ id: 'late', name: 'Late', run: () => {} }); } catch {}
        try { morrow.providers.register({ id: 'late-provider', apiVersion: 1, mount: () => {} }); } catch {}
        try { morrow.onChange(() => {}); } catch {}
        return () => { globalThis.__morrowCleanupCount++; remove(); };
      };`,
    });
    const started = deferred<void>();
    const activationGate = deferred<void>();
    pluginGlobals().__morrowActivationStarted = () => started.resolve();
    pluginGlobals().__morrowActivationGate = activationGate.promise;
    pluginGlobals().__morrowCleanupCount = 0;
    const subscribe = vi.spyOn(h.session, 'subscribe');

    const enabling = h.loader.setPluginEnabled('fixture', true);
    await started.promise;
    expect(h.registry.pluginActions().map((action) => action.id)).toEqual(['plugin:fixture:early']);
    expect(h.providers.getDatabaseProvider('fixture-provider')).not.toBeNull();

    const disabling = h.loader.setPluginEnabled('fixture', false);
    await disabling;
    expect(h.registry.pluginActions()).toEqual([]);
    expect(h.providers.getDatabaseProvider('fixture-provider')).toBeNull();

    const oldApi = pluginGlobals().__morrowOldApi as {
      commands: { add(command: { id: string; name: string; run(): void }): unknown };
      providers: { register(registration: { id: string; apiVersion: 1; mount(): void }): unknown };
      onChange(listener: () => void): unknown;
    };
    expect(() => oldApi.commands.add({ id: 'late-direct', name: 'Late direct', run: () => {} })).toThrow(
      /no longer active/i,
    );
    expect(() =>
      oldApi.providers.register({ id: 'late-direct-provider', apiVersion: 1, mount: () => {} }),
    ).toThrow(/no longer active/i);
    expect(() => oldApi.onChange(() => {})).toThrow(/no longer active/i);
    expect(subscribe).not.toHaveBeenCalled();

    activationGate.resolve();
    await enabling;

    expect(pluginGlobals().__morrowCleanupCount).toBe(1);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(h.providers.getDatabaseProvider('fixture-provider')).toBeNull();
    expect(h.providers.getDatabaseProvider('late-provider')).toBeNull();
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: false, loaded: false, error: null },
    ]);
  });

  it('keeps a completed plugin active when disabling cannot persist', async () => {
    const h = await createHarness({
      code: `export default (morrow) => {
        morrow.commands.add({ id: 'active', name: 'Active', run: () => {} });
      };`,
    });
    await h.loader.setPluginEnabled('fixture', true);
    expect(h.registry.pluginActions().map((action) => action.id)).toEqual(['plugin:fixture:active']);
    h.apply.mockImplementationOnce(async () => [{ ok: false, message: 'synthetic settings write failure' }]);

    await expect(h.loader.setPluginEnabled('fixture', false)).rejects.toThrow(
      'synthetic settings write failure',
    );

    expect(h.registry.pluginActions().map((action) => action.id)).toEqual(['plugin:fixture:active']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('does not reload when plugins are disallowed or the persisted plugin setting is off', async () => {
    const h = await createHarness({
      code: 'export default () => { throw new Error("must not activate"); };',
    });
    h.preferences.setPreferences({ plugins: false });
    await h.loader.reloadPlugin('fixture');
    h.preferences.setPreferences({ plugins: true });
    await h.loader.reloadPlugin('fixture');

    expect(h.readText).not.toHaveBeenCalledWith(MAIN_FILE);
    expect(h.objectUrls).toEqual([]);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: false, loaded: false, error: null },
    ]);
  });

  it('runs late cleanup from a reloaded generation without removing the new instance command', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__morrowActivationCount++;
        const generation = globalThis.__morrowActivationCount;
        const remove = morrow.commands.add({ id: 'shared', name: 'Instance ' + generation, run: () => {} });
        if (generation === 1) {
          globalThis.__morrowOldStarted();
          await globalThis.__morrowOldGate;
          return () => { globalThis.__morrowOldCleanupCount++; remove(); };
        }
        globalThis.__morrowNewStarted();
      };`,
    });
    const oldStarted = deferred<void>();
    const oldGate = deferred<void>();
    const newStarted = deferred<void>();
    pluginGlobals().__morrowActivationCount = 0;
    pluginGlobals().__morrowOldCleanupCount = 0;
    pluginGlobals().__morrowOldStarted = () => oldStarted.resolve();
    pluginGlobals().__morrowOldGate = oldGate.promise;
    pluginGlobals().__morrowNewStarted = () => newStarted.resolve();

    const firstLoad = h.loader.setPluginEnabled('fixture', true);
    await oldStarted.promise;
    const reload = h.loader.reloadPlugin('fixture');
    await newStarted.promise;
    await reload;
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Instance 2']);

    oldGate.resolve();
    await firstLoad;

    expect(pluginGlobals().__morrowOldCleanupCount).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Instance 2']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('does not let a late activation rejection replace the current generation error', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__morrowActivationCount++;
        if (globalThis.__morrowActivationCount === 1) {
          globalThis.__morrowFirstStarted();
          await globalThis.__morrowFirstGate;
          throw new Error('stale activation error');
        }
        if (globalThis.__morrowActivationCount === 2) {
          morrow.commands.add({ id: 'current', name: 'Current', run: () => {} });
          globalThis.__morrowCurrentStarted();
          return;
        }
        throw new Error('current activation error');
      };`,
    });
    const firstStarted = deferred<void>();
    const firstGate = deferred<void>();
    const currentStarted = deferred<void>();
    pluginGlobals().__morrowActivationCount = 0;
    pluginGlobals().__morrowFirstStarted = () => firstStarted.resolve();
    pluginGlobals().__morrowFirstGate = firstGate.promise;
    pluginGlobals().__morrowCurrentStarted = () => currentStarted.resolve();

    const firstLoad = h.loader.setPluginEnabled('fixture', true);
    await firstStarted.promise;
    const reload = h.loader.reloadPlugin('fixture');
    await currentStarted.promise;
    await reload;
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Current']);

    await h.loader.reloadPlugin('fixture');
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: 'current activation error' },
    ]);
    firstGate.resolve();
    await firstLoad;

    expect(h.registry.pluginActions()).toEqual([]);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: 'current activation error' },
    ]);
  });
});
