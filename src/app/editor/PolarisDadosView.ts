import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { DocNode, PageId } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
  isPolarisDadosViewData,
  polarisDadosViewDocIssue,
} from '../../core/polarisDadosView';
import type { PolarisDadosViewData } from '../../core/polarisDadosView';
import type { WorkspaceSession } from '../../storage/session';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { createLinkedViewApi } from '../plugins/linkedViewApi';
import type { LinkedViewApi } from '../plugins/linkedViewApi';
import { createProviderDataScope } from '../plugins/providerDataScope';
import {
  getDatabaseProvider,
  registerMountedDatabaseProvider,
  subscribeDatabaseProviders,
} from '../plugins/providerRegistry';
import type { RegisteredDatabaseProvider } from '../plugins/providerRegistry';
import { selectedProviderMarker } from '../plugins/providerMarker';

export interface PolarisDadosViewMountContext {
  readonly session: WorkspaceSession;
  readonly pageId: PageId;
}

interface PolarisDadosViewOptions {
  mountContext: PolarisDadosViewMountContext | null;
}

interface ProviderMountKey {
  readonly version: number;
  readonly viewId: string;
  readonly sourceDatabaseId: PageId;
  readonly provider: RegisteredDatabaseProvider;
  readonly locale: string;
  readonly editable: boolean;
}

interface ActiveProviderMount {
  readonly key: ProviderMountKey;
  readonly generation: symbol;
  readonly element: HTMLElement;
  readonly controller: AbortController;
  readonly disposeScope: () => void;
  readonly cleanupLinkedView: () => void;
  readonly view: LinkedViewApi;
  active: boolean;
  cleanupProvider: (() => void) | null;
  unregisterRoot: (() => void) | null;
}

function sameMountKey(a: ProviderMountKey, b: ProviderMountKey): boolean {
  return (
    a.version === b.version &&
    a.viewId === b.viewId &&
    a.sourceDatabaseId === b.sourceDatabaseId &&
    a.provider === b.provider &&
    a.locale === b.locale &&
    a.editable === b.editable
  );
}

function fallbackElement(
  ownerDocument: Document,
  titleValue: unknown,
  sourceValue: unknown,
  message = 'Linked view unavailable.',
): HTMLElement {
  const dom = ownerDocument.createElement('aside');
  dom.className = 'polaris-dados-view-fallback';
  dom.contentEditable = 'false';

  const title = ownerDocument.createElement('strong');
  title.textContent = typeof titleValue === 'string' ? titleValue : 'Linked view';
  const unavailable = ownerDocument.createElement('p');
  unavailable.textContent = message;
  const source = ownerDocument.createElement('p');
  source.append(ownerDocument.createTextNode('Source database: '));
  const sourceId = ownerDocument.createElement('code');
  sourceId.textContent = typeof sourceValue === 'string' ? sourceValue : '';
  source.append(sourceId);

  dom.append(title, unavailable, source);
  return dom;
}

function hasBoundView(doc: DocNode | undefined, viewId: string, sourceDatabaseId: PageId): boolean {
  if (!doc) return false;
  let count = 0;
  let matches = false;
  const visit = (node: DocNode) => {
    if (node.type === 'polarisDadosView' && node.attrs?.viewId === viewId) {
      count++;
      matches = node.attrs.sourceDatabaseId === sourceDatabaseId;
    }
    node.content?.forEach(visit);
  };
  visit(doc);
  return count === 1 && matches;
}

function mountLinkedViewProvider(
  dom: HTMLElement,
  initialData: PolarisDadosViewData,
  context: PolarisDadosViewMountContext,
  editor: { readonly isEditable: boolean },
  editorView: EditorView,
): { update(data: PolarisDadosViewData): void; destroy(): void } {
  const document = editorView.dom.ownerDocument;
  let data = initialData;
  let activeMount: ActiveProviderMount | null = null;
  let failed: { readonly key: ProviderMountKey; readonly message: string } | null = null;
  let disposed = false;
  let removeSessionListener = () => {};
  let removePreferenceListener = () => {};
  let removeProviderListener = () => {};
  let removeEditorContextListener = () => {};
  let removeCloseListener = () => {};

  const renderFallback = (message?: string) => {
    dom.replaceChildren(fallbackElement(document, data.title, data.sourceDatabaseId, message));
  };

  const stopMount = (mount: ActiveProviderMount, showFallback = true) => {
    if (activeMount !== mount || !mount.active) return;
    activeMount = null;
    mount.active = false;
    mount.controller.abort();
    try {
      mount.disposeScope();
    } catch {
      // A failed scope cleanup cannot keep another linked view alive.
    }
    const cleanupProvider = mount.cleanupProvider;
    mount.cleanupProvider = null;
    try {
      cleanupProvider?.();
    } catch {
      // A provider cleanup is isolated to this root.
    }
    try {
      mount.cleanupLinkedView();
    } catch {
      // Continue releasing this root if a linked-view listener throws.
    }
    try {
      mount.unregisterRoot?.();
    } catch {
      // The registry removes roots independently.
    }
    mount.element.replaceChildren();
    if (showFallback && !disposed) renderFallback();
  };

  const reconcile = () => {
    if (disposed) return;
    const state = context.session.getState();
    const owner = state.pages[context.pageId];
    if (
      context.session.isClosed ||
      !owner ||
      owner.encrypted ||
      isEffectivelyTrashed(state.pages, owner.id) ||
      context.session.unreadable.has(context.pageId) ||
      context.session.protectedReasons.has(context.pageId) ||
      !state.docs[context.pageId] ||
      polarisDadosViewDocIssue(state.docs[context.pageId]!) !== null ||
      !hasBoundView(state.docs[context.pageId], data.viewId, data.sourceDatabaseId)
    ) {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback('The linked view is no longer available in this note.');
      return;
    }
    const source = state.pages[data.sourceDatabaseId];
    if (!source || isEffectivelyTrashed(state.pages, source.id)) {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback(source ? 'The source database is in the trash.' : 'The source database is unavailable.');
      return;
    }

    const marker = selectedProviderMarker(source.extra.polarisDados);
    if (!marker) {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback('The source database has no supported provider.');
      return;
    }
    const provider = getDatabaseProvider(marker.provider);
    if (!provider) {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback('The source database provider is unavailable.');
      return;
    }

    let sourceSnapshot;
    try {
      sourceSnapshot = provider.data.snapshot(source.id);
    } catch (error) {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback(
        (error instanceof Error ? error.message : 'The source database could not be read.').slice(0, 300),
      );
      return;
    }
    if (sourceSnapshot.status !== 'ready') {
      if (activeMount) stopMount(activeMount);
      failed = null;
      renderFallback(
        sourceSnapshot.status === 'unsupported'
          ? sourceSnapshot.diagnostic.message
          : 'The source database is unavailable.',
      );
      return;
    }

    const preferences = getPreferences();
    const editable = editor.isEditable && !preferences.readingMode;
    const key: ProviderMountKey = {
      version: data.version,
      viewId: data.viewId,
      sourceDatabaseId: data.sourceDatabaseId,
      provider,
      locale: preferences.locale,
      editable,
    };
    if (activeMount && sameMountKey(activeMount.key, key)) {
      let currentSnapshot;
      try {
        currentSnapshot = activeMount.view.snapshot();
      } catch {
        currentSnapshot = null;
      }
      if (
        currentSnapshot?.status === 'ready' &&
        currentSnapshot.pageId === context.pageId &&
        currentSnapshot.viewId === data.viewId &&
        currentSnapshot.sourceDatabaseId === data.sourceDatabaseId &&
        currentSnapshot.sourceStatus.status === 'available'
      )
        return;
      stopMount(activeMount, false);
    }
    if (failed && sameMountKey(failed.key, key)) {
      renderFallback(failed.message);
      return;
    }
    if (activeMount) stopMount(activeMount, false);

    const element = document.createElement('div');
    element.className = 'database database-provider-root polaris-dados-linked-provider-root';
    element.dataset.morrowDatabaseProvider = provider.id;
    element.contentEditable = 'false';
    const controller = new AbortController();
    const generation = Symbol(data.viewId);
    const ownerViewIsActive = () => {
      const currentState = context.session.getState();
      const currentOwner = currentState.pages[context.pageId];
      const ownerDoc = currentState.docs[context.pageId];
      return (
        !context.session.isClosed &&
        Boolean(currentOwner && ownerDoc) &&
        !isEffectivelyTrashed(currentState.pages, context.pageId) &&
        !currentOwner!.encrypted &&
        !context.session.unreadable.has(context.pageId) &&
        !context.session.protectedReasons.has(context.pageId) &&
        polarisDadosViewDocIssue(ownerDoc!) === null &&
        hasBoundView(ownerDoc, data.viewId, data.sourceDatabaseId)
      );
    };
    const mountRef: { current: ActiveProviderMount | null } = { current: null };
    const isActive = () => {
      const mount = mountRef.current;
      return Boolean(
        mount &&
        mount.active &&
        activeMount === mount &&
        ownerViewIsActive() &&
        !context.session.isClosed &&
        provider.ownerIsActive() &&
        getDatabaseProvider(provider.id) === provider,
      );
    };
    const currentEditable = () => editor.isEditable && !getPreferences().readingMode;
    const scope = createProviderDataScope(provider.data, source.id, {
      isActive,
      editable: currentEditable,
    });
    const linkedViewCleanups = new Set<() => void>();
    let view;
    try {
      view = createLinkedViewApi({
        session: context.session,
        pageId: context.pageId,
        viewId: data.viewId,
        sourceDatabaseId: source.id,
        mountGeneration: generation,
        ownerIsActive: () => provider.ownerIsActive() && ownerViewIsActive(),
        isMountGenerationActive: (candidate) => candidate === generation && isActive(),
        isHostReadonly: () => !currentEditable(),
        registerCleanup: (cleanup) => {
          linkedViewCleanups.add(cleanup);
        },
      });
    } catch (error) {
      scope.dispose();
      for (const cleanup of [...linkedViewCleanups]) {
        try {
          cleanup();
        } catch {
          // A failed bound-handle cleanup cannot block the inert fallback.
        }
      }
      linkedViewCleanups.clear();
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      failed = { key, message };
      renderFallback(message);
      return;
    }
    const cleanupLinkedView = () => {
      for (const cleanup of [...linkedViewCleanups]) cleanup();
      linkedViewCleanups.clear();
    };
    const mount: ActiveProviderMount = {
      key,
      generation,
      element,
      controller,
      disposeScope: () => scope.dispose(),
      cleanupLinkedView,
      view,
      active: true,
      cleanupProvider: null,
      unregisterRoot: null,
    };
    mountRef.current = mount;
    activeMount = mount;

    let viewSnapshot: ReturnType<LinkedViewApi['snapshot']>;
    try {
      viewSnapshot = view.snapshot();
    } catch (error) {
      mount.active = false;
      activeMount = null;
      controller.abort();
      scope.dispose();
      cleanupLinkedView();
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      failed = { key, message };
      renderFallback(message);
      return;
    }
    if (viewSnapshot.status !== 'ready' || viewSnapshot.sourceStatus.status !== 'available') {
      mount.active = false;
      activeMount = null;
      controller.abort();
      scope.dispose();
      cleanupLinkedView();
      const message =
        viewSnapshot.status === 'unsupported'
          ? viewSnapshot.diagnostic.message
          : viewSnapshot.status === 'missing'
            ? 'The linked view or its source database is unavailable.'
            : (viewSnapshot.sourceStatus.diagnostic?.message ?? 'The source database is unavailable.');
      failed = { key, message };
      renderFallback(message);
      return;
    }

    const unregisterRoot = registerMountedDatabaseProvider(provider, source.id, element, () =>
      stopMount(mount),
    );
    if (!unregisterRoot) {
      mount.active = false;
      activeMount = null;
      controller.abort();
      scope.dispose();
      cleanupLinkedView();
      renderFallback('The source database provider changed before it could mount.');
      return;
    }
    mount.unregisterRoot = unregisterRoot;

    try {
      const cleanup = provider.mount({
        element,
        databaseId: source.id,
        data: scope.api,
        locale: preferences.locale,
        editable,
        signal: controller.signal,
        view,
      });
      if (cleanup !== undefined && typeof cleanup !== 'function') {
        throw new Error('A provider mount must return a cleanup function or nothing.');
      }
      mount.cleanupProvider = typeof cleanup === 'function' ? cleanup : null;
      if (!isActive()) {
        const cleanupAfterReentrantUnmount = mount.cleanupProvider;
        mount.cleanupProvider = null;
        try {
          cleanupAfterReentrantUnmount?.();
        } catch {
          // A mount that unloads itself still gets its returned cleanup exactly once.
        }
        stopMount(mount);
        return;
      }
      failed = null;
      dom.replaceChildren(element);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      stopMount(mount, false);
      failed = { key, message };
      renderFallback(message);
    }
  };

  const onEditorContextChange = () => reconcile();
  editorView.dom.addEventListener('morrow:linked-view-context', onEditorContextChange);
  removeEditorContextListener = () =>
    editorView.dom.removeEventListener('morrow:linked-view-context', onEditorContextChange);
  removeSessionListener = context.session.subscribe(reconcile);
  removePreferenceListener = subscribePreferences(reconcile);
  removeProviderListener = subscribeDatabaseProviders(reconcile);
  removeCloseListener = context.session.onClose(() => destroy());
  renderFallback();
  reconcile();

  function destroy(): void {
    if (disposed) return;
    disposed = true;
    removeEditorContextListener();
    removeSessionListener();
    removePreferenceListener();
    removeProviderListener();
    removeCloseListener();
    if (activeMount) stopMount(activeMount, false);
  }

  return {
    update(nextData) {
      data = nextData;
      reconcile();
    },
    destroy,
  };
}

function rawPolarisDadosViewMarkers(doc: ProseMirrorNode): Map<string, number> {
  const markers = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name !== 'rawBlock' || typeof node.attrs.text !== 'string') return;
    const source = node.attrs.text as string;
    const openings = /<!--[ \t\r\n]*morrow:polaris-dados-view\s*:/gi;
    let match: RegExpExecArray | null;
    while ((match = openings.exec(source))) {
      const end = source.indexOf('-->', match.index);
      const marker = source.slice(match.index, end === -1 ? source.length : end + 3);
      markers.set(marker, (markers.get(marker) ?? 0) + 1);
    }
  });
  return markers;
}

function addsRawPolarisDadosViewMarker(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  const previous = rawPolarisDadosViewMarkers(before);
  for (const [marker, count] of rawPolarisDadosViewMarkers(after)) {
    if (count > (previous.get(marker) ?? 0)) return true;
  }
  return false;
}

export const PolarisDadosView = Node.create<PolarisDadosViewOptions>({
  name: 'polarisDadosView',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { mountContext: null };
  },

  addAttributes() {
    return {
      version: { default: null },
      viewId: { default: null },
      sourceDatabaseId: { default: null },
      title: { default: null },
      columnOrder: { default: null },
      filter: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-morrow-polaris-dados-view]',
        getAttrs: (element) => {
          const marker = (element as HTMLElement).getAttribute('data-morrow-polaris-dados-view');
          const data = marker ? decodePolarisDadosViewMarker(marker) : null;
          return data ?? false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const data = isPolarisDadosViewData(node.attrs) ? node.attrs : null;
    const marker = data ? encodePolarisDadosViewMarker(data) : '';
    const title = typeof data?.title === 'string' ? data.title : 'Linked view';
    const source = typeof data?.sourceDatabaseId === 'string' ? data.sourceDatabaseId : '';
    return [
      'div',
      { 'data-morrow-polaris-dados-view': marker },
      ['strong', {}, title],
      ['p', {}, 'Linked view unavailable.'],
      ['p', {}, 'Source database: ', ['code', {}, source]],
    ];
  },

  addNodeView() {
    return ({ node, editor, view }) => {
      const ownerDocument = view.dom.ownerDocument;
      const dom = ownerDocument.createElement('div');
      dom.className = 'polaris-dados-view-node';
      let data = isPolarisDadosViewData(node.attrs) ? node.attrs : null;
      let providerMount: ReturnType<typeof mountLinkedViewProvider> | null = null;
      if (data && this.options.mountContext) {
        providerMount = mountLinkedViewProvider(dom, data, this.options.mountContext, editor, view);
      } else {
        dom.append(fallbackElement(ownerDocument, node.attrs.title, node.attrs.sourceDatabaseId));
      }

      return {
        dom,
        update(nextNode) {
          if (nextNode.type !== node.type || !isPolarisDadosViewData(nextNode.attrs)) return false;
          data = nextNode.attrs;
          providerMount?.update(data);
          if (!providerMount) {
            dom.replaceChildren(fallbackElement(ownerDocument, data.title, data.sourceDatabaseId));
          }
          return true;
        },
        stopEvent(event) {
          const NativeNode = ownerDocument.defaultView?.Node;
          return Boolean(
            providerMount && NativeNode && event.target instanceof NativeNode && dom.contains(event.target),
          );
        },
        ignoreMutation(mutation) {
          return mutation.type !== 'selection' && dom.contains(mutation.target);
        },
        destroy() {
          providerMount?.destroy();
        },
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => {
          if (!transaction.docChanged) return true;
          return (
            polarisDadosViewDocIssue(transaction.doc.toJSON()) === null &&
            !addsRawPolarisDadosViewMarker(transaction.before, transaction.doc)
          );
        },
      }),
    ];
  },
});
