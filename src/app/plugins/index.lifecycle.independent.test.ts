// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as PluginLoader from './index';
import type * as PluginRegistry from './registry';
import type * as PluginProviders from './providerRegistry';
import type * as Preferences from '../platform/preferences';
import type { WorkspaceSession } from '../../storage/session';

const SETTINGS_FILE = '.morrow/plugins.json';
const PLUGINS_FOLDER = '.morrow/plugins';
const FIXTURE_FOLDER = `${PLUGINS_FOLDER}/fixture`;
const FIXTURE_MAIN = `${FIXTURE_FOLDER}/main.js`;

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

type LoaderGlobals = typeof globalThis & {
  __independentFixtureActivations?: number;
  __independentOtherActivations?: number;
  __independentCleanupCount?: number;
  __independentLateDisposerCount?: number;
  __independentFirstActivationStarted?: () => void;
  __independentFirstActivationGate?: Promise<void>;
  __independentReentrantSettingsStarted?: () => void;
  __independentReentrantSettingsGate?: Promise<string | null>;
  __independentReentrantReload?: () => Promise<void>;
  __independentReentrantReloadPromise?: Promise<void>;
};

function globals(): LoaderGlobals {
  return globalThis as LoaderGlobals;
}

function installModuleUrls() {
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

  const createObjectURL = vi.fn((blob: FixtureBlob) =>
    `data:text/javascript;charset=utf-8,${encodeURIComponent(blob.source)}#independent-${nextModule++}`,
  );
  const revokeObjectURL = vi.fn();
  const FixtureURL = class extends NativeURL {};
  Object.defineProperties(FixtureURL, {
    createObjectURL: { value: createObjectURL },
    revokeObjectURL: { value: revokeObjectURL },
  });
  vi.stubGlobal('Blob', FixtureBlob);
  vi.stubGlobal('URL', FixtureURL);
}

interface Harness {
  files: Map<string, string>;
  readText: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  delayRead(path: string, promise: Promise<string | null>, started?: () => void): void;
  clearReadDelay(path: string): void;
  holdSettingsWrite(): { started: Promise<void>; release(): void };
  installPlugin(id: string, source: string): void;
  loader: typeof PluginLoader;
  registry: typeof PluginRegistry;
  providers: typeof PluginProviders;
  preferences: typeof Preferences;
  session: WorkspaceSession;
  databaseName: string;
}

let harness: Harness | undefined;
let priorMorrow: Window['morrow'];
let priorPreferences: string | null;
let databaseSequence = 0;

async function createHarness(options: { enabled?: string[]; code?: string } = {}): Promise<Harness> {
  vi.resetModules();
  priorMorrow = window.morrow;
  priorPreferences = localStorage.getItem('morrow.preferences');

  const files = new Map<string, string>([
    [SETTINGS_FILE, JSON.stringify({ enabled: options.enabled ?? [] })],
  ]);
  const installPlugin = (id: string, source: string) => {
    const folder = `${PLUGINS_FOLDER}/${id}`;
    files.set(
      `${folder}/manifest.json`,
      JSON.stringify({
        id,
        name: `Synthetic ${id}`,
        version: '1.0.0',
        description: 'Independent lifecycle fixture.',
        author: 'Test',
      }),
    );
    files.set(`${folder}/main.js`, source);
  };
  installPlugin('fixture', options.code ?? 'export default () => {};');

  const delayedReads = new Map<string, { promise: Promise<string | null>; started?: () => void }>();
  const readText = vi.fn((path: string) => {
    const delayed = delayedReads.get(path);
    if (delayed) {
      delayed.started?.();
      return delayed.promise;
    }
    return Promise.resolve(files.get(path) ?? null);
  });

  let settingsWriteHold:
    | { started: Deferred<void>; gate: Deferred<void> }
    | undefined;
  const apply = vi.fn(async (operations: unknown) => {
    const writes = operations as Array<{ op: string; path: string; text?: string }>;
    if (settingsWriteHold && writes.some((operation) => operation.path === SETTINGS_FILE)) {
      const hold = settingsWriteHold;
      settingsWriteHold = undefined;
      hold.started.resolve();
      await hold.gate.promise;
    }
    return writes.map((operation) => {
      if (operation.op !== 'write' || typeof operation.text !== 'string')
        return { ok: false, message: 'Unsupported fixture operation.' };
      files.set(operation.path, operation.text);
      return { ok: true };
    });
  });
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
  };
  window.morrow = {
    platform: 'linux',
    version: 'independent-test',
    dataPath: '/synthetic-independent',
    vault,
  } as unknown as NonNullable<Window['morrow']>;
  installModuleUrls();

  const preferences = await import('../platform/preferences');
  preferences.setPreferences({ plugins: true });
  const { openRepository } = await import('../../storage/repository');
  const { WorkspaceSession } = await import('../../storage/session');
  const databaseName = `plugin-loader-independent-${databaseSequence++}`;
  const opened = await WorkspaceSession.open(await openRepository(databaseName));
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const workspace = await import('../workspace');
  workspace.setSession(session);

  harness = {
    files,
    readText,
    apply,
    delayRead(path, promise, started) {
      delayedReads.set(path, { promise, started });
    },
    clearReadDelay(path) {
      delayedReads.delete(path);
    },
    holdSettingsWrite() {
      const started = deferred<void>();
      const gate = deferred<void>();
      settingsWriteHold = { started, gate };
      return { started: started.promise, release: () => gate.resolve() };
    },
    installPlugin,
    loader: await import('./index'),
    registry: await import('./registry'),
    providers: await import('./providerRegistry'),
    preferences,
    session,
    databaseName,
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
    '__independentFixtureActivations',
    '__independentOtherActivations',
    '__independentCleanupCount',
    '__independentLateDisposerCount',
    '__independentFirstActivationStarted',
    '__independentFirstActivationGate',
    '__independentReentrantSettingsStarted',
    '__independentReentrantSettingsGate',
    '__independentReentrantReload',
    '__independentReentrantReloadPromise',
  ])
    Reflect.deleteProperty(globalThis, key);
  vi.unstubAllGlobals();
  window.morrow = priorMorrow;
  if (priorPreferences === null) localStorage.removeItem('morrow.preferences');
  else localStorage.setItem('morrow.preferences', priorPreferences);
  vi.restoreAllMocks();
});

describe('plugin loader lifecycle, independent fixtures', () => {
  it('reconciles a held per-plugin enable after global stop/start and continues unrelated startup', async () => {
    const h = await createHarness({
      enabled: ['fixture', 'other'],
      code: `export default (morrow) => {
        globalThis.__independentFixtureActivations++;
        morrow.commands.add({ id: 'fixture', name: 'Fixture', run: () => {} });
      };`,
    });
    h.installPlugin(
      'other',
      `export default (morrow) => {
        globalThis.__independentOtherActivations++;
        morrow.commands.add({ id: 'other', name: 'Other', run: () => {} });
      };`,
    );
    const oldMainRead = deferred<string | null>();
    const oldMainStarted = deferred<void>();
    h.delayRead(FIXTURE_MAIN, oldMainRead.promise, () => oldMainStarted.resolve());
    globals().__independentFixtureActivations = 0;
    globals().__independentOtherActivations = 0;

    const firstStartup = h.loader.startPlugins();
    await oldMainStarted.promise;
    const settingsWrite = h.holdSettingsWrite();
    const enabling = h.loader.setPluginEnabled('fixture', true);
    await settingsWrite.started;

    h.preferences.setPreferences({ plugins: false });
    h.loader.stopPlugins();
    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();
    expect(globals().__independentOtherActivations).toBe(1);

    oldMainRead.resolve(
      `export default (morrow) => {
        globalThis.__independentFixtureActivations++;
        morrow.commands.add({ id: 'fixture', name: 'Fixture', run: () => {} });
      };`,
    );
    h.clearReadDelay(FIXTURE_MAIN);
    await firstStartup;
    settingsWrite.release();
    await enabling;

    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toEqual({ enabled: ['fixture', 'other'] });
    expect(globals().__independentFixtureActivations).toBe(1);
    expect(globals().__independentOtherActivations).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.id).sort()).toEqual([
      'plugin:fixture:fixture',
      'plugin:other:other',
    ]);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
      { id: 'other', enabled: true, loaded: true, error: null },
    ]);
  });

  it('restarts a persisted enable skipped during global stop/start while activation was pending', async () => {
    const h = await createHarness({
      enabled: ['other'],
      code: `export default async (morrow) => {
        globalThis.__independentFixtureActivations++;
        const generation = globalThis.__independentFixtureActivations;
        if (generation === 1) {
          globalThis.__independentFirstActivationStarted();
          await globalThis.__independentFirstActivationGate;
          return () => { globalThis.__independentLateDisposerCount++; };
        }
        morrow.commands.add({ id: 'fixture', name: 'Fixture', run: () => {} });
      };`,
    });
    h.installPlugin(
      'other',
      `export default (morrow) => {
        globalThis.__independentOtherActivations++;
        morrow.commands.add({ id: 'other', name: 'Other', run: () => {} });
      };`,
    );
    const activationStarted = deferred<void>();
    const activationGate = deferred<void>();
    globals().__independentFixtureActivations = 0;
    globals().__independentOtherActivations = 0;
    globals().__independentLateDisposerCount = 0;
    globals().__independentFirstActivationStarted = () => activationStarted.resolve();
    globals().__independentFirstActivationGate = activationGate.promise;

    const enabling = h.loader.setPluginEnabled('fixture', true);
    await activationStarted.promise;
    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toEqual({ enabled: ['fixture', 'other'] });

    h.preferences.setPreferences({ plugins: false });
    h.loader.stopPlugins();
    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();
    expect(globals().__independentOtherActivations).toBe(1);

    activationGate.resolve();
    await enabling;
    expect(globals().__independentFixtureActivations).toBe(2);
    expect(globals().__independentLateDisposerCount).toBe(1);
    expect(globals().__independentOtherActivations).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.id).sort()).toEqual([
      'plugin:fixture:fixture',
      'plugin:other:other',
    ]);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
      { id: 'other', enabled: true, loaded: true, error: null },
    ]);
  });

  it('keeps a newer same-ID resource when an older activation rejects after reload', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__independentFixtureActivations++;
        const generation = globalThis.__independentFixtureActivations;
        morrow.commands.add({ id: 'same', name: 'Generation ' + generation, run: () => {} });
        if (generation === 1) {
          globalThis.__independentFirstActivationStarted();
          await globalThis.__independentFirstActivationGate;
          throw new Error('stale activation error');
        }
      };`,
    });
    const firstStarted = deferred<void>();
    const firstGate = deferred<void>();
    globals().__independentFixtureActivations = 0;
    globals().__independentFirstActivationStarted = () => firstStarted.resolve();
    globals().__independentFirstActivationGate = firstGate.promise;

    const firstLoad = h.loader.setPluginEnabled('fixture', true);
    await firstStarted.promise;
    await h.loader.reloadPlugin('fixture');
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Generation 2']);

    firstGate.resolve();
    await firstLoad;
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Generation 2']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('does not publish a stale error when failure cleanup reentrantly reloads the same ID', async () => {
    const h = await createHarness({
      enabled: ['fixture'],
      code: `export default (morrow) => {
        globalThis.__independentFixtureActivations++;
        const generation = globalThis.__independentFixtureActivations;
        morrow.commands.add({ id: 'shared', name: 'Generation ' + generation, run: () => {} });
        if (generation === 1) {
          morrow.register(() => {
            globalThis.__independentCleanupCount++;
            globalThis.__independentReentrantReloadPromise = globalThis.__independentReentrantReload();
          });
          throw new Error('stale activation error');
        }
      };`,
    });
    const settingsStarted = deferred<void>();
    const settingsGate = deferred<string | null>();
    globals().__independentFixtureActivations = 0;
    globals().__independentCleanupCount = 0;
    globals().__independentReentrantSettingsStarted = () => settingsStarted.resolve();
    globals().__independentReentrantSettingsGate = settingsGate.promise;
    globals().__independentReentrantReload = () => {
      h.delayRead(SETTINGS_FILE, settingsGate.promise, () => settingsStarted.resolve());
      return h.loader.reloadPlugin('fixture');
    };

    const startup = h.loader.startPlugins();
    await settingsStarted.promise;
    h.clearReadDelay(SETTINGS_FILE);
    await startup;
    expect(globals().__independentCleanupCount).toBe(1);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: null },
    ]);

    settingsGate.resolve(JSON.stringify({ enabled: ['fixture'] }));
    await globals().__independentReentrantReloadPromise;
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Generation 2']);
    expect(await h.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('runs a late disposer once without unregistering the replacement generation', async () => {
    const h = await createHarness({
      code: `export default async (morrow) => {
        globalThis.__independentFixtureActivations++;
        const generation = globalThis.__independentFixtureActivations;
        const remove = morrow.commands.add({ id: 'shared', name: 'Generation ' + generation, run: () => {} });
        if (generation === 1) {
          globalThis.__independentFirstActivationStarted();
          await globalThis.__independentFirstActivationGate;
          return () => {
            globalThis.__independentLateDisposerCount++;
            remove();
          };
        }
      };`,
    });
    const firstStarted = deferred<void>();
    const firstGate = deferred<void>();
    globals().__independentFixtureActivations = 0;
    globals().__independentLateDisposerCount = 0;
    globals().__independentFirstActivationStarted = () => firstStarted.resolve();
    globals().__independentFirstActivationGate = firstGate.promise;

    const firstEnable = h.loader.setPluginEnabled('fixture', true);
    await firstStarted.promise;
    await h.loader.setPluginEnabled('fixture', false);
    await h.loader.setPluginEnabled('fixture', true);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Generation 2']);

    firstGate.resolve();
    await firstEnable;
    expect(globals().__independentLateDisposerCount).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.label)).toEqual(['Generation 2']);
  });

  it('cleans partial registration after activation failure and preserves a live instance on write failure', async () => {
    const failing = await createHarness({
      code: `export default (morrow) => {
        morrow.commands.add({ id: 'partial', name: 'Partial', run: () => {} });
        morrow.providers.register({ id: 'fixture-provider', apiVersion: 1, mount: () => {} });
        morrow.register(() => { globalThis.__independentCleanupCount++; });
        throw new Error('partial activation failure');
      };`,
    });
    globals().__independentCleanupCount = 0;
    await failing.loader.setPluginEnabled('fixture', true);
    expect(failing.registry.pluginActions()).toEqual([]);
    expect(failing.providers.getDatabaseProvider('fixture-provider')).toBeNull();
    expect(globals().__independentCleanupCount).toBe(1);
    expect(await failing.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: false, error: 'partial activation failure' },
    ]);

    const working = await createHarness({
      code: `export default (morrow) => {
        morrow.commands.add({ id: 'live', name: 'Live instance', run: () => {} });
      };`,
    });
    await working.loader.setPluginEnabled('fixture', true);
    working.apply.mockImplementationOnce(async () => [
      { ok: false, message: 'synthetic preference write failure' },
    ]);
    await expect(working.loader.setPluginEnabled('fixture', false)).rejects.toThrow(
      'synthetic preference write failure',
    );
    expect(JSON.parse(working.files.get(SETTINGS_FILE) ?? '{}')).toEqual({ enabled: ['fixture'] });
    expect(working.registry.pluginActions().map((action) => action.label)).toEqual(['Live instance']);
    expect(await working.loader.listPlugins()).toMatchObject([
      { id: 'fixture', enabled: true, loaded: true, error: null },
    ]);
  });

  it('honors both global permission and persisted disable across reload and startup', async () => {
    const h = await createHarness({
      code: `export default (morrow) => {
        globalThis.__independentFixtureActivations++;
        morrow.commands.add({ id: 'enabled', name: 'Enabled', run: () => {} });
      };`,
    });
    globals().__independentFixtureActivations = 0;
    h.preferences.setPreferences({ plugins: false });
    await h.loader.reloadPlugin('fixture');
    await h.loader.setPluginEnabled('fixture', true);
    await h.loader.reloadPlugin('fixture');
    expect(globals().__independentFixtureActivations).toBe(0);
    expect(h.registry.pluginActions()).toEqual([]);

    h.preferences.setPreferences({ plugins: true });
    await h.loader.startPlugins();
    expect(globals().__independentFixtureActivations).toBe(1);
    expect(h.registry.pluginActions().map((action) => action.id)).toEqual(['plugin:fixture:enabled']);

    await h.loader.setPluginEnabled('fixture', false);
    await h.loader.reloadPlugin('fixture');
    expect(globals().__independentFixtureActivations).toBe(1);
    expect(h.registry.pluginActions()).toEqual([]);
    expect(JSON.parse(h.files.get(SETTINGS_FILE) ?? '{}')).toEqual({ enabled: [] });
  });
});
