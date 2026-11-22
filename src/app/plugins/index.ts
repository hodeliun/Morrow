// plugins: javascript in the vault's .morrow/plugins folder, one folder each with a manifest.json and a
// main.js. they run inside morrow with the same reach into your notes it has, so they stay off on each
// computer until turned on there, and each one is turned on by name
import { Puzzle } from 'lucide-react';
import type { Editor, Range } from '@tiptap/core';
import { markdownToDoc } from '../../core/markdown/parse';
import { docToMarkdown } from '../../core/markdown/serialize';
import { displayTitle } from '../../core/model';
import type { PageId } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import { focusedEditor } from '../editor/commits';
import { captureEditorInsertionTarget } from '../editor/editorInsertion';
import { createPage } from '../operations';
import { desktop } from '../platform/desktop';
import { getPreferences } from '../platform/preferences';
import { getLocale } from '../i18n';
import { activeRoute, openPage } from '../router';
import { toast } from '../ui';
import { getSession, getState, run } from '../workspace';
import {
  addPluginAction,
  addPluginBlock,
  addPluginInlineColorControl,
  addPluginInlineFormulaPresentation,
  addPluginNoteStylePanel,
  pluginActions,
  pluginBlocks,
} from './registry';
import type {
  PluginInlineColorControlMount,
  PluginInlineFormulaPresentationMount,
  PluginNoteStylePanelMount,
} from './registry';
import { createDataApi } from './dataApi';
import { getDatabaseProvider, registerDatabaseProvider } from './providerRegistry';
import type { DatabaseProviderRegistration } from './providerApi';
import { clonePluginPageProperties } from './pageInfo';
import { selectedProviderMarker } from './providerMarker';
import type { PluginEditorInsertionTargetV1 } from './editorApi';
import { addInlineFormulaSlashCommand } from './inlineFormulaAuthoring';
import type { PluginInlineFormulaEditAction, PluginInlineFormulaSlashCommand } from './inlineFormulaApi';
import { definePluginLocaleApi } from './localeApi';

export type { PluginLocaleApi } from './localeApi';

export const PLUGINS_FOLDER = '.morrow/plugins';
const SETTINGS_FILE = '.morrow/plugins.json';
const ID = /^[a-z0-9][\w-]{0,63}$/i;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean;
  loaded: boolean;
  error: string | null;
}

interface Running {
  generation: number;
  active: boolean;
  activated: boolean;
  cleanups: Array<() => void>;
  cleanupWrappers: WeakMap<() => void, () => void>;
}

interface LoadAttempt {
  generation: number;
  promise: Promise<void>;
}

interface StartOperation {
  promise: Promise<void>;
  invalidatedIds: Set<string>;
  pendingAtStart: Set<string>;
}

interface PendingPluginSetting {
  generation: number;
  enabled: boolean;
}

const running = new Map<string, Running>();
const loading = new Map<string, LoadAttempt>();
const ownerGenerations = new Map<string, number>();
const pluginActionGenerations = new Map<string, number>();
const pendingPluginSettings = new Map<string, PendingPluginSetting>();
const errors = new Map<string, string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
let startOperation: StartOperation | null = null;
let pluginLifecycleGeneration = 0;
let lastStartedLifecycleGeneration: number | null = null;

export function subscribePluginList(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const vault = () => desktop?.vault ?? null;

async function readJson(path: string): Promise<unknown> {
  try {
    const text = await vault()?.readText(path);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

async function writeText(path: string, text: string): Promise<void> {
  const result = (await vault()?.apply([{ op: 'write', path, text }])) as Array<{
    ok: boolean;
    message?: string;
  }>;
  const failed = result?.find((item) => !item.ok);
  if (failed) throw new Error(failed.message ?? 'Could not save.');
}

async function enabledIds(): Promise<string[]> {
  const raw = (await readJson(SETTINGS_FILE)) as { enabled?: unknown } | null;
  return Array.isArray(raw?.enabled) ? raw.enabled.filter((id): id is string => typeof id === 'string') : [];
}

async function readManifest(id: string): Promise<PluginManifest | null> {
  const raw = (await readJson(`${PLUGINS_FOLDER}/${id}/manifest.json`)) as Partial<PluginManifest> | null;
  if (!raw) return null;
  const text = (value: unknown, fallback = '') =>
    typeof value === 'string' ? value.slice(0, 300) : fallback;
  return {
    id,
    name: text(raw.name, id),
    version: text(raw.version),
    description: text(raw.description),
    author: text(raw.author),
  };
}

// every plugin in the vault's folder, turned on or not
export async function listPlugins(): Promise<PluginInfo[]> {
  const api = vault();
  if (!api || !(await api.exists(PLUGINS_FOLDER).catch(() => false))) return [];
  const files = await api.list(PLUGINS_FOLDER).catch(() => []);
  const ids = new Set<string>();
  for (const file of files) {
    const match = /^\.morrow\/plugins\/([^/]+)\/manifest\.json$/.exec(file.path);
    if (match && ID.test(match[1]!)) ids.add(match[1]!);
  }
  const enabled = await enabledIds();
  const plugins: PluginInfo[] = [];
  for (const id of [...ids].sort()) {
    const manifest = await readManifest(id);
    if (!manifest) continue;
    plugins.push({
      ...manifest,
      enabled: enabled.includes(id),
      loaded: running.has(id),
      error: errors.get(id) ?? null,
    });
  }
  return plugins;
}

function isCurrentLoad(id: string, attempt: LoadAttempt): boolean {
  return loading.get(id) === attempt && ownerGenerations.get(id) === attempt.generation;
}

function registerCleanup(id: string, state: Running, cleanup: () => void): () => void {
  const existing = state.cleanupWrappers.get(cleanup);
  if (existing) return existing;

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cleanup();
  };
  state.cleanupWrappers.set(cleanup, dispose);
  if (state.active && running.get(id) === state) state.cleanups.push(dispose);
  else dispose();
  return dispose;
}

function unloadState(id: string, state: Running): void {
  if (running.get(id) === state) running.delete(id);
  if (!state.active) return;
  state.active = false;
  for (const cleanup of state.cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // a plugin that fails to tidy up is still turned off
    }
  }
}

function invalidatePlugin(id: string): number {
  const generation = (ownerGenerations.get(id) ?? 0) + 1;
  ownerGenerations.set(id, generation);
  loading.delete(id);
  errors.delete(id);
  const state = running.get(id);
  if (state) unloadState(id, state);
  return generation;
}

function cancelPendingLoad(id: string): void {
  const generation = (ownerGenerations.get(id) ?? 0) + 1;
  ownerGenerations.set(id, generation);
  loading.delete(id);
  const state = running.get(id);
  if (state && !state.activated) unloadState(id, state);
}

function nextPluginActionGeneration(id: string): number {
  const generation = (pluginActionGenerations.get(id) ?? 0) + 1;
  pluginActionGenerations.set(id, generation);
  return generation;
}

// what a plugin is given to work with. everything it adds is taken away again when it is turned off
function pluginApi(id: string, state: Running) {
  const session = getSession();
  const ownerIsActive = () => {
    try {
      return running.get(id) === state && state.active && !session.isClosed && getSession() === session;
    } catch {
      return false;
    }
  };
  const assertActive = () => {
    if (!ownerIsActive()) throw new Error('The plugin instance is no longer active.');
  };
  const keep = (cleanup: () => void) => registerCleanup(id, state, cleanup);
  const editorOwnerIsActive = () => {
    try {
      return ownerIsActive() && getSession() === session;
    } catch {
      return false;
    }
  };
  const bindInsertionTarget = (target: PluginEditorInsertionTargetV1): PluginEditorInsertionTargetV1 => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      target.dispose();
    };
    const dispose = registerCleanup(id, state, release);
    const forgetCleanup = () => {
      const index = state.cleanups.indexOf(dispose);
      if (index >= 0) state.cleanups.splice(index, 1);
    };
    return Object.freeze({
      version: target.version,
      insert(markdown: string) {
        assertActive();
        const result = target.insert(markdown);
        dispose();
        forgetCleanup();
        return result;
      },
      dispose() {
        dispose();
        if (ownerIsActive()) forgetCleanup();
      },
    });
  };
  const insertion = Object.freeze({
    version: 1 as const,
    capture() {
      assertActive();
      const target = captureEditorInsertionTarget({
        generation: state.generation,
        isActive: editorOwnerIsActive,
      });
      return target ? bindInsertionTarget(target) : null;
    },
  });
  const data = createDataApi({
    session,
    ownerIsActive,
    isProviderActive: (databaseId) => {
      const state = getState();
      const page = state.pages[databaseId];
      if (!page || page.kind !== 'database' || !page.database || !Object.hasOwn(page.extra, 'polarisDados'))
        return false;
      if (session.unreadable.has(databaseId) || isEffectivelyTrashed(state.pages, databaseId)) return false;
      const selection = selectedProviderMarker(page.extra.polarisDados);
      if (selection?.provider !== 'polaris-dados') return false;
      const provider = getDatabaseProvider(selection.provider);
      return provider?.apiVersion === 1 && provider.data === data;
    },
    isHostReadonly: () => getPreferences().readingMode,
    registerCleanup: keep,
  });
  const pageInfo = (pageId: PageId) => {
    const page = getState().pages[pageId];
    if (!page) return null;
    return {
      id: page.id,
      title: displayTitle(page),
      path: getSession().pathOf(page.id),
      tags: [...page.tags],
      properties: clonePluginPageProperties(page.extra),
      parentId: page.parentId,
      kind: page.kind,
    };
  };
  const plugin = {
    version: desktop?.version ?? '',
    plugin: id,
    data,
    inlineFormulas: {
      version: 1 as const,
      registerPresentation(mount: PluginInlineFormulaPresentationMount, onEdit?: PluginInlineFormulaEditAction) {
        assertActive();
        if (id !== 'polaris-dados')
          throw new Error('Only Polaris Dados can present inline formula results.');
        if (typeof mount !== 'function') throw new Error('An inline formula presentation needs a mount function.');
        if (onEdit !== undefined && typeof onEdit !== 'function')
          throw new Error('An inline formula edit action needs a handler.');
        return keep(addPluginInlineFormulaPresentation(id, mount, onEdit));
      },
      addSlashCommand(command: PluginInlineFormulaSlashCommand) {
        assertActive();
        if (id !== 'polaris-dados')
          throw new Error('Only Polaris Dados can add an inline formula slash command.');
        if (!command || typeof command !== 'object' || typeof command.onInvoke !== 'function')
          throw new Error('An inline formula slash command needs an onInvoke handler.');
        return keep(
          addInlineFormulaSlashCommand(
            { generation: state.generation, isActive: ownerIsActive },
            bindInsertionTarget,
            command,
          ),
        );
      },
    },
    providers: Object.freeze({
      version: 1 as const,
      register: (registration: DatabaseProviderRegistration) => {
        assertActive();
        if (!registration || typeof registration !== 'object')
          throw new Error('A provider registration is required.');
        if (typeof registration.mount !== 'function')
          throw new Error('A provider must supply a mount function.');
        const guardedRegistration: DatabaseProviderRegistration = {
          get id() {
            return registration.id;
          },
          get apiVersion() {
            return registration.apiVersion;
          },
          mount: (context) => {
            assertActive();
            return registration.mount(context);
          },
        };
        const unregister = registerDatabaseProvider(id, ownerIsActive, data, guardedRegistration);
        try {
          const unsubscribeClose = session.onClose(unregister);
          return keep(() => {
            unsubscribeClose();
            unregister();
          });
        } catch (error) {
          unregister();
          throw error;
        }
      },
    }),
    commands: {
      add(command: { id: string; name: string; shortcut?: string; run: () => void }) {
        assertActive();
        if (typeof command?.id !== 'string' || typeof command.run !== 'function')
          throw new Error('A command needs an id and run.');
        const action = {
          id: `plugin:${id}:${command.id}`,
          label: String(command.name ?? command.id),
          group: 'General' as const,
          icon: Puzzle,
          ...(typeof command.shortcut === 'string' ? { shortcut: command.shortcut } : {}),
          keywords: `plugin ${id}`,
          run: () => {
            if (ownerIsActive()) command.run();
          },
        };
        const unregister = addPluginAction(id, action);
        return keep(() => {
          if (pluginActions().includes(action)) unregister();
        });
      },
    },
    slash: {
      add(item: {
        id: string;
        title: string;
        description?: string;
        keywords?: string;
        markdown?: string;
        run?: () => void;
      }) {
        assertActive();
        if (typeof item?.id !== 'string') throw new Error('A slash item needs an id.');
        const block = {
          id: `plugin:${id}:${item.id}`,
          title: String(item.title ?? item.id),
          ...(item.description ? { description: String(item.description) } : {}),
          icon: Puzzle,
          keywords: `${item.keywords ?? ''} plugin ${id}`,
          run: (editor: Editor, range: Range) => {
            if (!ownerIsActive()) return;
            editor.chain().focus().deleteRange(range).run();
            if (typeof item.markdown === 'string')
              editor
                .chain()
                .focus()
                .insertContent(markdownToDoc(item.markdown).content ?? [])
                .run();
            else item.run?.();
          },
        };
        const unregister = addPluginBlock(id, block);
        return keep(() => {
          if (pluginBlocks().includes(block)) unregister();
        });
      },
    },
    pages: {
      list: () => {
        assertActive();
        return Object.keys(getState().pages).map(pageInfo).filter(Boolean);
      },
      get: (pageId: string) => {
        assertActive();
        return pageInfo(pageId);
      },
      read: (pageId: string) => {
        assertActive();
        const doc = getState().docs[pageId];
        return doc ? docToMarkdown(doc) : null;
      },
      current: () => {
        assertActive();
        const route = activeRoute();
        return route.name === 'page' ? pageInfo(route.id) : null;
      },
      open: (pageId: string) => {
        assertActive();
        return openPage(pageId);
      },
      create(options: { title?: string; markdown?: string; parentId?: string | null }) {
        assertActive();
        const pageId = createPage({
          title: options?.title ?? 'Untitled',
          parentId: options?.parentId ?? null,
          open: false,
        });
        if (pageId && typeof options?.markdown === 'string')
          run({ type: 'page.setDoc', id: pageId, doc: markdownToDoc(options.markdown), now: Date.now() });
        return pageId;
      },
      write(pageId: string, markdown: string) {
        assertActive();
        const result = run({
          type: 'page.setDoc',
          id: pageId,
          doc: markdownToDoc(String(markdown)),
          now: Date.now(),
        });
        if (!result.ok) throw new Error(result.error);
      },
      noteStylePanel: {
        add(mount: PluginNoteStylePanelMount) {
          assertActive();
          if (id !== 'polaris-documento')
            throw new Error('Only Polaris Documento can add a note-style panel.');
          if (typeof mount !== 'function') throw new Error('A note-style panel needs a mount function.');
          return keep(addPluginNoteStylePanel(id, mount));
        },
      },
    },
    editor: {
      insertion,
      inlineColorControl: {
        add(mount: PluginInlineColorControlMount) {
          assertActive();
          if (id !== 'polaris-documento')
            throw new Error('Only Polaris Documento can add an inline color control.');
          if (typeof mount !== 'function') throw new Error('An inline color control needs a mount function.');
          return keep(addPluginInlineColorControl(id, mount));
        },
      },
      insert(markdown: string) {
        assertActive();
        const target = captureEditorInsertionTarget({
          generation: state.generation,
          isActive: editorOwnerIsActive,
        });
        if (!target) return false;
        try {
          return target.insert(String(markdown)).ok;
        } finally {
          target.dispose();
        }
      },
      selectedText() {
        assertActive();
        const editor = focusedEditor();
        if (!editor || editor.isDestroyed) return '';
        const { from, to } = editor.state.selection;
        return editor.state.doc.textBetween(from, to, '\n');
      },
    },
    onChange(listener: () => void) {
      assertActive();
      return keep(
        session.subscribe(() => {
          if (ownerIsActive()) listener();
        }),
      );
    },
    notice: (message: string) => {
      assertActive();
      toast(String(message));
    },
    styles: {
      add(css: string) {
        assertActive();
        const style = document.createElement('style');
        style.dataset.plugin = id;
        style.textContent = String(css);
        document.head.appendChild(style);
        return keep(() => style.remove());
      },
    },
    storage: {
      async get() {
        assertActive();
        const value = await readJson(`${PLUGINS_FOLDER}/${id}/data.json`);
        assertActive();
        return value;
      },
      async set(value: unknown) {
        assertActive();
        await writeText(`${PLUGINS_FOLDER}/${id}/data.json`, JSON.stringify(value, null, 2));
        assertActive();
      },
    },
    register: (cleanup: () => void) => {
      assertActive();
      return keep(cleanup);
    },
  };
  return Object.freeze(
    definePluginLocaleApi(plugin, () => {
      assertActive();
      return getLocale();
    }),
  );
}

function load(id: string, expectedGeneration?: number): Promise<void> {
  if (!ID.test(id)) return Promise.resolve();

  let generation = expectedGeneration;
  if (generation === undefined) {
    const current = loading.get(id);
    if (current && isCurrentLoad(id, current)) return current.promise;
    const state = running.get(id);
    if (state?.active && state.activated) return Promise.resolve();
    generation = (ownerGenerations.get(id) ?? 0) + 1;
    ownerGenerations.set(id, generation);
  } else if (ownerGenerations.get(id) !== generation) {
    return Promise.resolve();
  }

  const current = loading.get(id);
  if (current && current.generation === generation && isCurrentLoad(id, current)) return current.promise;
  const currentState = running.get(id);
  if (currentState?.active && currentState.activated) return Promise.resolve();
  if (currentState) unloadState(id, currentState);

  errors.delete(id);
  const attempt: LoadAttempt = { generation, promise: Promise.resolve() };
  const promise = Promise.resolve()
    .then(() => loadAttempt(id, attempt))
    .finally(() => {
      if (loading.get(id) === attempt) loading.delete(id);
    });
  attempt.promise = promise;
  loading.set(id, attempt);
  return promise;
}

async function loadAttempt(id: string, attempt: LoadAttempt): Promise<void> {
  let state: Running | undefined;
  let url: string | undefined;
  try {
    if (!isCurrentLoad(id, attempt)) return;
    const code = await vault()?.readText(`${PLUGINS_FOLDER}/${id}/main.js`);
    if (!isCurrentLoad(id, attempt)) return;
    if (!code) {
      errors.set(id, 'main.js is missing.');
      return;
    }

    state = {
      generation: attempt.generation,
      active: true,
      activated: false,
      cleanups: [],
      cleanupWrappers: new WeakMap(),
    };
    running.set(id, state);
    url = URL.createObjectURL(
      new Blob([`${code}\n//# sourceURL=morrow-plugin-${id}.js`], { type: 'text/javascript' }),
    );
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: (api: unknown) => unknown;
      activate?: (api: unknown) => unknown;
    };
    if (!isCurrentLoad(id, attempt) || running.get(id) !== state || !state.active) return;
    const activate = module.default ?? module.activate;
    if (typeof activate !== 'function') throw new Error('main.js should export a function as its default.');
    const result = await activate(pluginApi(id, state));
    if (typeof result === 'function') registerCleanup(id, state, result as () => void);
    if (isCurrentLoad(id, attempt) && running.get(id) === state && state.active) state.activated = true;
  } catch (error) {
    if (!isCurrentLoad(id, attempt)) return;
    if (state && running.get(id) === state) unloadState(id, state);
    if (!isCurrentLoad(id, attempt)) return;
    errors.set(id, error instanceof Error ? error.message : String(error));
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

// at start, and when plugins are allowed on this computer, the ones turned on in this vault load
export function startPlugins(): Promise<void> {
  if (!getPreferences().plugins || !vault()) {
    startOperation = null;
    return Promise.resolve();
  }
  if (startOperation) return startOperation.promise;

  const operation: StartOperation = {
    promise: Promise.resolve(),
    invalidatedIds: new Set(),
    pendingAtStart: new Set(pendingPluginSettings.keys()),
  };
  lastStartedLifecycleGeneration = pluginLifecycleGeneration;
  startOperation = operation;
  operation.promise = Promise.resolve()
    .then(async () => {
      const ids = await enabledIds();
      if (startOperation !== operation || !getPreferences().plugins || !vault()) return;
      for (const id of ids) {
        if (startOperation !== operation || !getPreferences().plugins || !vault()) return;
        if (
          operation.invalidatedIds.has(id) ||
          operation.pendingAtStart.has(id) ||
          pendingPluginSettings.has(id)
        )
          continue;
        await load(id);
      }
      if (startOperation !== operation || !getPreferences().plugins || !vault()) return;
      for (const id of errors.keys())
        toast(`The plugin “${id}” could not start: ${errors.get(id)}`, { tone: 'error' });
      notify();
    })
    .finally(() => {
      if (startOperation === operation) startOperation = null;
    });
  return operation.promise;
}

export function stopPlugins(): void {
  pluginLifecycleGeneration += 1;
  startOperation = null;
  const ids = new Set([...ownerGenerations.keys(), ...loading.keys(), ...running.keys(), ...errors.keys()]);
  for (const id of ids) invalidatePlugin(id);
  notify();
}

export async function setPluginEnabled(id: string, enabled: boolean): Promise<void> {
  startOperation?.invalidatedIds.add(id);
  const actionGeneration = nextPluginActionGeneration(id);
  const lifecycleGeneration = pluginLifecycleGeneration;
  pendingPluginSettings.set(id, { generation: actionGeneration, enabled });
  if (!enabled) cancelPendingLoad(id);
  try {
    const ids = new Set(await enabledIds());
    if (enabled) ids.add(id);
    else ids.delete(id);
    await writeText(SETTINGS_FILE, `${JSON.stringify({ enabled: [...ids].sort() }, null, 2)}\n`);
    if (pendingPluginSettings.get(id)?.generation === actionGeneration) pendingPluginSettings.delete(id);
    if (pluginActionGenerations.get(id) === actionGeneration) {
      const lifecycleIsCurrent = pluginLifecycleGeneration === lifecycleGeneration;
      const currentLifecycleHasStarted = lastStartedLifecycleGeneration === pluginLifecycleGeneration;
      if (
        enabled &&
        getPreferences().plugins &&
        vault() &&
        (lifecycleIsCurrent || currentLifecycleHasStarted)
      )
        await load(id);
      else if (!enabled && lifecycleIsCurrent) invalidatePlugin(id);
    }
    notify();
  } catch (error) {
    if (pendingPluginSettings.get(id)?.generation === actionGeneration) pendingPluginSettings.delete(id);
    const lifecycleIsCurrent = pluginLifecycleGeneration === lifecycleGeneration;
    const currentLifecycleHasStarted = lastStartedLifecycleGeneration === pluginLifecycleGeneration;
    if (
      !enabled &&
      pluginActionGenerations.get(id) === actionGeneration &&
      (lifecycleIsCurrent || currentLifecycleHasStarted) &&
      getPreferences().plugins &&
      vault()
    ) {
      try {
        const persistedIds = await enabledIds();
        if (
          pluginActionGenerations.get(id) === actionGeneration &&
          (pluginLifecycleGeneration === lifecycleGeneration ||
            lastStartedLifecycleGeneration === pluginLifecycleGeneration) &&
          getPreferences().plugins &&
          vault() &&
          persistedIds.includes(id)
        )
          await load(id);
      } catch {
        // Preserve the settings write error after trying to restore the persisted state.
      }
    }
    throw error;
  } finally {
    if (pendingPluginSettings.get(id)?.generation === actionGeneration) pendingPluginSettings.delete(id);
  }
}

export async function reloadPlugin(id: string): Promise<void> {
  if (pendingPluginSettings.has(id)) return;
  startOperation?.invalidatedIds.add(id);
  const actionGeneration = nextPluginActionGeneration(id);
  const lifecycleGeneration = pluginLifecycleGeneration;
  const generation = invalidatePlugin(id);
  try {
    if (!getPreferences().plugins || !vault()) return;
    const ids = await enabledIds();
    if (
      pluginActionGenerations.get(id) !== actionGeneration ||
      pluginLifecycleGeneration !== lifecycleGeneration ||
      ownerGenerations.get(id) !== generation ||
      pendingPluginSettings.has(id) ||
      !getPreferences().plugins ||
      !vault() ||
      !ids.includes(id)
    )
      return;
    await load(id, generation);
  } finally {
    if (
      pluginActionGenerations.get(id) === actionGeneration &&
      pluginLifecycleGeneration === lifecycleGeneration &&
      ownerGenerations.get(id) === generation
    )
      notify();
  }
}

const README = `# Morrow plugins

Each plugin is a folder here, named after its id, holding two files:

- manifest.json: {"id": "word-count", "name": "Word count", "version": "1.0.0", "description": "...", "author": "..."}
- main.js: a JavaScript module whose default export is a function Morrow calls with its API

\`\`\`js
export default function (morrow) {
  morrow.commands.add({
    id: 'count',
    name: 'Count the words on this page',
    run: () => {
      const page = morrow.pages.current();
      const words = (morrow.pages.read(page.id) ?? '').split(/\\s+/).filter(Boolean).length;
      morrow.notice(\`\${words} words\`);
    },
  });
}
\`\`\`

Plugins run with the same access to your notes Morrow has. Only add ones you trust.
See PLUGINS.md in Morrow's repository for everything the API offers.
`;

// makes the folder, with a note on how to write a plugin, and shows it
export async function openPluginsFolder(): Promise<void> {
  const api = vault();
  if (!api) return;
  if (!(await api.exists(`${PLUGINS_FOLDER}/README.md`).catch(() => false)))
    await writeText(`${PLUGINS_FOLDER}/README.md`, README).catch(() => undefined);
  await api.reveal(`${PLUGINS_FOLDER}/README.md`);
}
