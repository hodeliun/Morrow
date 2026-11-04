import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createPdfProtocolHandler, createPdfResourceRegistry } from './pdfResources.js';
import type { PdfResourceRegistry, PdfVaultContext } from './pdfResources.js';

export type PdfViewerStatus =
  'loading' | 'ready' | 'invalid' | 'password-required' | 'unavailable' | 'failed';

export interface PdfViewerState {
  readonly viewerId: string;
  readonly sequence: number;
  readonly status: PdfViewerStatus;
  readonly name: string;
  readonly size: number;
  readonly pageCount?: number;
  readonly matches?: number;
  readonly activeMatchOrdinal?: number;
}

export interface PdfViewerBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfViewerEvent {
  preventDefault(): void;
}

export interface PdfFindResult {
  readonly requestId: number;
  readonly matches: number;
  readonly activeMatchOrdinal: number;
  readonly finalUpdate: boolean;
}

export interface PdfViewerFrame {
  readonly processId: number;
  readonly routingId: number;
  readonly frameTreeNodeId?: number;
  readonly url: string;
  readonly framesInSubtree: PdfViewerFrame[];
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface PdfViewerWebContents {
  readonly id: number;
  readonly session: PdfViewerSession;
  readonly mainFrame: PdfViewerFrame;
  readonly hostWebContents?: PdfViewerWebContents | null;
  isDestroyed(): boolean;
  close(options?: { readonly waitForBeforeUnload?: boolean }): void;
  stop(): void;
  getZoomFactor(): number;
  loadURL(url: string): Promise<void>;
  findInPage(
    text: string,
    options: { readonly forward: boolean; readonly findNext: boolean; readonly matchCase: boolean },
  ): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void;
  on(event: 'will-navigate', listener: (event: PdfViewerEvent, url: string) => void): this;
  on(event: 'did-finish-load', listener: () => void): this;
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => void,
  ): this;
  on(event: 'render-process-gone', listener: () => void): this;
  on(event: 'found-in-page', listener: (event: unknown, result: PdfFindResult) => void): this;
  on(event: 'focus', listener: () => void): this;
  on(event: 'destroyed', listener: () => void): this;
  off(event: 'will-navigate', listener: (event: PdfViewerEvent, url: string) => void): this;
  off(event: 'did-finish-load', listener: () => void): this;
  off(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      description: string,
      url: string,
      isMainFrame: boolean,
    ) => void,
  ): this;
  off(event: 'render-process-gone', listener: () => void): this;
  off(event: 'found-in-page', listener: (event: unknown, result: PdfFindResult) => void): this;
  off(event: 'focus', listener: () => void): this;
  off(event: 'destroyed', listener: () => void): this;
}

export interface PdfViewerProtocol {
  handle(scheme: string, handler: (request: Request) => Promise<Response>): Promise<void> | void;
  unhandle(scheme: string): Promise<void> | void;
}

export interface PdfViewerSession {
  readonly protocol: PdfViewerProtocol;
  readonly webRequest: PdfViewerWebRequest;
  setPermissionRequestHandler(handler: (...args: unknown[]) => void): void;
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean): void;
  on(
    event: 'will-download',
    listener: (event: PdfViewerEvent, item: { cancel(): void }, contents: PdfViewerWebContents) => void,
  ): this;
  off(
    event: 'will-download',
    listener: (event: PdfViewerEvent, item: { cancel(): void }, contents: PdfViewerWebContents) => void,
  ): this;
  closeAllConnections(): Promise<void>;
}

export interface PdfViewerWebRequest {
  onBeforeRequest(
    filter: { readonly urls: string[] } | null,
    listener?: (
      details: { readonly url: string },
      callback: (decision: { readonly cancel: boolean }) => void,
    ) => void,
  ): void;
}

export interface PdfViewerWindow {
  readonly contentView: {
    addChildView(view: PdfViewerView): void;
    removeChildView(view: PdfViewerView): void;
  };
  isDestroyed(): boolean;
  getContentBounds(): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  on(event: 'closed', listener: () => void): this;
  off(event: 'closed', listener: () => void): this;
}

export interface PdfViewerOwner {
  readonly window: PdfViewerWindow;
  readonly webContents: PdfViewerWebContents;
  readonly vaultId: string;
}

export interface PdfViewerView {
  readonly webContents: PdfViewerWebContents;
  setBounds(bounds: PdfViewerBounds): void;
  setVisible(visible: boolean): void;
}

export interface PdfViewerWebPreferences {
  readonly session: PdfViewerSession;
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly nodeIntegrationInWorker: false;
  readonly nodeIntegrationInSubFrames: false;
  readonly webSecurity: true;
  readonly webviewTag: false;
  readonly plugins: true;
  readonly disableBlinkFeatures: 'FileSystemAccessLocal';
}

export interface PdfViewerRuntime {
  createSession(partition: string, options: { readonly cache: false }): PdfViewerSession;
  createView(options: { readonly webPreferences: PdfViewerWebPreferences }): PdfViewerView;
  getAllWebContents(): readonly PdfViewerWebContents[];
  now?(): number;
  setTimeout?(callback: () => void, delayMs: number): unknown;
  clearTimeout?(timer: unknown): void;
  delay?(delayMs: number): Promise<void>;
  createId?(): string;
}

export interface PdfViewerManagerOptions {
  readonly runtime: PdfViewerRuntime;
  readonly getContext: (vaultId: string) => PdfVaultContext | null;
  readonly getOwner: () => PdfViewerOwner | null;
  readonly onState?: (state: PdfViewerState) => void;
  readonly onFocus?: (viewerId: string) => void;
  readonly onExternalLink?: (viewerId: string, url: string) => void;
  readonly readinessTimeoutMs?: number;
  readonly frameEvaluationBudgetMs?: number;
  readonly framePollIntervalMs?: number;
}

export type PdfViewerOpenError =
  | 'no-owner'
  | 'no-vault'
  | 'vault-changed'
  | 'unsupported-type'
  | 'invalid-resource'
  | 'file-unavailable'
  | 'viewer-unavailable';

export type PdfViewerOpenResult =
  | { readonly ok: true; readonly viewerId: string; readonly state: PdfViewerState }
  | { readonly ok: false; readonly code: PdfViewerOpenError };

export interface PdfViewerManager {
  open(vaultId: string, relativePath: string): Promise<PdfViewerOpenResult>;
  present(viewerId: string, bounds: PdfViewerBounds | null, visible: boolean): boolean;
  find(viewerId: string, query: string, forward?: boolean): boolean;
  getState(viewerId: string): PdfViewerState | null;
  close(viewerId: string): void;
  clear(): void;
}

interface PdfViewerIdentity {
  readonly window: PdfViewerWindow;
  readonly webContents: PdfViewerWebContents;
  readonly mainFrameProcessId: number;
  readonly mainFrameRoutingId: number;
  readonly vaultId: string;
}

interface PdfDocumentSnapshot {
  readonly status: 'loading' | 'ready' | 'invalid' | 'password-required';
  readonly pageCount?: number;
}

interface ManagedPdfViewer {
  readonly viewerId: string;
  readonly identity: PdfViewerIdentity;
  readonly context: PdfVaultContext;
  readonly session: PdfViewerSession;
  readonly view: PdfViewerView;
  readonly registry: PdfResourceRegistry;
  readonly token: string;
  readonly initialUrl: string;
  readonly name: string;
  readonly size: number;
  readonly abort: AbortController;
  readonly downloadListener: (
    event: PdfViewerEvent,
    item: { cancel(): void },
    contents: PdfViewerWebContents,
  ) => void;
  readonly willNavigateListener: (event: PdfViewerEvent, url: string) => void;
  readonly didFinishLoadListener: () => void;
  readonly didFailLoadListener: (
    event: unknown,
    errorCode: number,
    description: string,
    url: string,
    isMainFrame: boolean,
  ) => void;
  readonly renderGoneListener: () => void;
  readonly foundListener: (event: unknown, result: PdfFindResult) => void;
  readonly focusListener: () => void;
  readonly destroyedListener: () => void;
  readonly closedListener: () => void;
  readonly requestListener: (
    details: { readonly url: string },
    callback: (decision: { readonly cancel: boolean }) => void,
  ) => void;
  state: PdfViewerState;
  attached: boolean;
  visible: boolean;
  disposed: boolean;
  lastQuery: string | null;
  activeFindRequestId: number | null;
  pendingFindResults: PdfFindResult[];
}

const PDF_SCHEME = 'morrow-pdf';
const PDF_RESOURCE_URL = (token: string) => `${PDF_SCHEME}://document/${token}/selected.pdf`;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const DEFAULT_FRAME_EVALUATION_BUDGET_MS = 250;
const DEFAULT_FRAME_POLL_INTERVAL_MS = 80;
const MAX_FIND_QUERY_LENGTH = 512;
const INITIAL_BOUNDS: PdfViewerBounds = { x: 0, y: 0, width: 1, height: 1 };

export const PDF_FRAME_SNAPSHOT = `(() => {
  const viewer = document.querySelector('pdf-viewer');
  const root = viewer?.shadowRoot ?? null;
  if (!viewer || !root) return { status: 'loading' };
  const toolbar = root.querySelector('#toolbar');
  const plugin = root.querySelector('#plugin');
  const dimensions = viewer.documentDimensions ?? null;
  const pageDimensions = Array.isArray(dimensions?.pageDimensions) ? dimensions.pageDimensions : [];
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  const progress = finite(viewer.loadProgress_);
  const pageCount = finite(viewer.docLength_) ?? finite(toolbar?.getAttribute('doc-length'));
  const pluginRect = plugin?.getBoundingClientRect() ?? null;
  const passwordDialog = root.querySelector('viewer-password-dialog, #passwordDialog');
  const hasOpenDialog = (scope) => {
    for (const dialog of scope.querySelectorAll('dialog')) {
      const bounds = dialog.getBoundingClientRect();
      if (dialog.open && dialog.isConnected && !dialog.hidden && bounds.width > 0 && bounds.height > 0) return true;
    }
    for (const element of scope.querySelectorAll('*'))
      if (element.shadowRoot && hasOpenDialog(element.shadowRoot)) return true;
    return false;
  };
  const passwordRequired = !!passwordDialog && passwordDialog.isConnected &&
    passwordDialog.getAttribute('aria-hidden') !== 'true' &&
    hasOpenDialog(passwordDialog.shadowRoot ?? passwordDialog);
  const error = viewer.showErrorDialog === true || viewer.loadState_ === 'failed' || progress === -1;
  const pagesReady = pageCount !== null && Number.isSafeInteger(pageCount) && pageCount > 0 &&
    pageDimensions.length === pageCount &&
    pageDimensions.every((page) => finite(page?.width) > 0 && finite(page?.height) > 0);
  const pluginReady = !!plugin && plugin.isConnected && plugin.getAttribute('type') === 'application/x-google-chrome-pdf' &&
    !!pluginRect && pluginRect.width > 0 && pluginRect.height > 0;
  const ready = viewer.loadState_ === 'success' && progress === 100 && pagesReady && pluginReady && !error;
  return {
    status: error ? 'invalid' : (passwordRequired ? 'password-required' : (ready ? 'ready' : 'loading')),
    pageCount: ready ? pageCount : undefined,
  };
})()`;

function sameContext(current: PdfVaultContext | null, expected: PdfVaultContext): boolean {
  return Boolean(
    current &&
    current.vaultId === expected.vaultId &&
    current.generation === expected.generation &&
    path.resolve(current.root) === path.resolve(expected.root) &&
    path.resolve(current.realRoot) === path.resolve(expected.realRoot),
  );
}

function isWindowOpen(url: string): string | null {
  try {
    const candidate = new URL(url);
    if (
      (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') ||
      candidate.username ||
      candidate.password ||
      !candidate.hostname
    )
      return null;
    return candidate.href;
  } catch {
    return null;
  }
}

function frameKey(frame: PdfViewerFrame): string {
  return `${frame.processId}:${frame.routingId}:${frame.frameTreeNodeId ?? ''}`;
}

function finiteBounds(bounds: PdfViewerBounds): boolean {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function safeInvoke(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    /* Observer failure cannot interrupt viewer lifecycle. */
  }
}

export function createPdfViewerManager(options: PdfViewerManagerOptions): PdfViewerManager {
  const viewers = new Map<string, ManagedPdfViewer>();
  const now = options.runtime.now ?? Date.now;
  const wait =
    options.runtime.delay ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const setTimer =
    options.runtime.setTimeout ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer =
    options.runtime.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  function captureIdentity(owner: PdfViewerOwner): PdfViewerIdentity | null {
    try {
      if (owner.window.isDestroyed() || owner.webContents.isDestroyed()) return null;
      const frame = owner.webContents.mainFrame;
      if (frame.isDestroyed()) return null;
      return {
        window: owner.window,
        webContents: owner.webContents,
        mainFrameProcessId: frame.processId,
        mainFrameRoutingId: frame.routingId,
        vaultId: owner.vaultId,
      };
    } catch {
      return null;
    }
  }

  function identityIsCurrent(identity: PdfViewerIdentity, context: PdfVaultContext): boolean {
    try {
      const owner = options.getOwner();
      if (
        !owner ||
        owner.window !== identity.window ||
        owner.webContents !== identity.webContents ||
        owner.vaultId !== identity.vaultId
      )
        return false;
      if (owner.window.isDestroyed() || owner.webContents.isDestroyed()) return false;
      const frame = owner.webContents.mainFrame;
      return (
        !frame.isDestroyed() &&
        frame.processId === identity.mainFrameProcessId &&
        frame.routingId === identity.mainFrameRoutingId &&
        sameContext(options.getContext(identity.vaultId), context)
      );
    } catch {
      return false;
    }
  }

  function emitState(
    item: ManagedPdfViewer,
    patch: Partial<Omit<PdfViewerState, 'viewerId' | 'sequence'>>,
  ): void {
    if (item.disposed) return;
    const changed = Object.entries(patch).some(
      ([key, value]) => item.state[key as keyof PdfViewerState] !== value,
    );
    if (!changed) return;
    item.state = { ...item.state, ...patch, viewerId: item.viewerId, sequence: item.state.sequence + 1 };
    safeInvoke(() => options.onState?.(item.state));
  }

  function emitExternalLink(item: ManagedPdfViewer, rawUrl: string): void {
    if (item.disposed || !identityIsCurrent(item.identity, item.context)) return;
    const url = isWindowOpen(rawUrl);
    if (!url) return;
    safeInvoke(() => options.onExternalLink?.(item.viewerId, url));
  }

  function getRelatedContents(item: ManagedPdfViewer): PdfViewerWebContents[] {
    const all = new Map<number, PdfViewerWebContents>();
    try {
      for (const contents of options.runtime.getAllWebContents()) {
        if (!contents || contents.isDestroyed()) continue;
        let related = contents === item.view.webContents || contents.session === item.session;
        const seen = new Set<number>();
        let host = contents.hostWebContents ?? null;
        while (!related && host) {
          if (host === item.view.webContents) {
            related = true;
            break;
          }
          if (seen.has(host.id)) break;
          seen.add(host.id);
          host = host.hostWebContents ?? null;
        }
        if (related) all.set(contents.id, contents);
      }
    } catch {
      /* A destroyed WebContents can race frame enumeration. */
    }
    all.set(item.view.webContents.id, item.view.webContents);
    return [...all.values()];
  }

  function currentFrames(item: ManagedPdfViewer): PdfViewerFrame[] {
    const frames = new Map<string, PdfViewerFrame>();
    for (const contents of getRelatedContents(item)) {
      if (contents.isDestroyed()) continue;
      try {
        for (const frame of contents.mainFrame.framesInSubtree) {
          if (frame.isDestroyed()) continue;
          let protocol = '';
          try {
            protocol = new URL(frame.url).protocol;
          } catch {
            continue;
          }
          if (protocol !== 'chrome-extension:' && protocol !== 'chrome-untrusted:') continue;
          frames.set(`${contents.id}:${frameKey(frame)}`, frame);
        }
      } catch {
        /* Frame trees can change while Chromium replaces an OOPIF. */
      }
    }
    return [...frames.values()];
  }

  function isFrameStillCurrent(
    item: ManagedPdfViewer,
    expectedKey: string,
    expectedFrame: PdfViewerFrame,
  ): boolean {
    if (item.disposed || expectedFrame.isDestroyed()) return false;
    for (const frame of currentFrames(item)) {
      if (
        frameKey(frame) === expectedKey &&
        frame.processId === expectedFrame.processId &&
        frame.routingId === expectedFrame.routingId
      )
        return true;
    }
    return false;
  }

  function boundedFrameSnapshot(
    frame: PdfViewerFrame,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<PdfDocumentSnapshot | null> {
    if (signal.aborted || frame.isDestroyed()) return Promise.resolve(null);
    let timer: unknown;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimer(() => resolve(null), budgetMs);
    });
    const read = Promise.resolve()
      .then(() => frame.executeJavaScript(PDF_FRAME_SNAPSHOT))
      .then((value): PdfDocumentSnapshot | null => {
        if (!value || typeof value !== 'object' || !('status' in value)) return null;
        const status = value.status;
        if (
          status !== 'loading' &&
          status !== 'ready' &&
          status !== 'invalid' &&
          status !== 'password-required'
        )
          return null;
        const pageCount =
          'pageCount' in value && Number.isSafeInteger(value.pageCount) && Number(value.pageCount) > 0
            ? Number(value.pageCount)
            : undefined;
        return { status, ...(pageCount === undefined ? {} : { pageCount }) };
      })
      .catch(() => null);
    return Promise.race([read, timeout]).finally(() => clearTimer(timer));
  }

  async function monitorDocument(item: ManagedPdfViewer): Promise<void> {
    const timeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    const budgetMs = options.frameEvaluationBudgetMs ?? DEFAULT_FRAME_EVALUATION_BUDGET_MS;
    const intervalMs = options.framePollIntervalMs ?? DEFAULT_FRAME_POLL_INTERVAL_MS;
    const deadline = now() + timeoutMs;
    let passwordFlow = false;
    while (
      !item.abort.signal.aborted &&
      !item.disposed &&
      viewers.get(item.viewerId) === item &&
      (now() < deadline || passwordFlow)
    ) {
      if (!identityIsCurrent(item.identity, item.context)) {
        close(item.viewerId);
        return;
      }
      const candidates = currentFrames(item);
      for (const frame of candidates) {
        const key = frameKey(frame);
        const frameBudget = passwordFlow ? budgetMs : Math.max(1, Math.min(budgetMs, deadline - now()));
        const snapshot = await boundedFrameSnapshot(frame, frameBudget, item.abort.signal);
        if (!snapshot || !isFrameStillCurrent(item, key, frame)) continue;
        if (snapshot.status === 'ready' && snapshot.pageCount) {
          emitState(item, { status: 'ready', pageCount: snapshot.pageCount });
          return;
        }
        if (snapshot.status === 'invalid' || snapshot.status === 'password-required') {
          emitState(item, { status: snapshot.status });
          if (snapshot.status === 'invalid') return;
          passwordFlow = true;
        } else if (
          passwordFlow &&
          item.state.status === 'password-required' &&
          snapshot.status === 'loading'
        ) {
          emitState(item, { status: 'loading' });
        }
      }
      await wait(
        passwordFlow ? Math.min(1_000, intervalMs * 5) : Math.min(intervalMs, Math.max(0, deadline - now())),
      );
    }
    if (!item.abort.signal.aborted && !item.disposed && item.state.status === 'loading')
      emitState(item, { status: 'failed' });
  }

  function cleanup(item: ManagedPdfViewer): void {
    if (item.disposed) return;
    item.disposed = true;
    item.abort.abort();
    item.registry.release(item.token);
    item.registry.clear();
    try {
      item.view.webContents.stopFindInPage('clearSelection');
    } catch {
      /* The WebContents may already be destroyed. */
    }
    try {
      item.view.webContents.off('will-navigate', item.willNavigateListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('did-finish-load', item.didFinishLoadListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('did-fail-load', item.didFailLoadListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('render-process-gone', item.renderGoneListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('found-in-page', item.foundListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('focus', item.focusListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.view.webContents.off('destroyed', item.destroyedListener);
    } catch {
      /* A destroyed WebContents has no listeners to retain. */
    }
    try {
      item.identity.window.off('closed', item.closedListener);
    } catch {
      /* A closed window has no listeners to retain. */
    }
    try {
      item.session.off('will-download', item.downloadListener);
    } catch {
      /* The private session is being discarded. */
    }
    try {
      item.session.webRequest.onBeforeRequest(null);
    } catch {
      /* The private session is being discarded. */
    }
    try {
      item.session.setPermissionRequestHandler(() => undefined);
    } catch {
      /* The private session is being discarded. */
    }
    try {
      item.session.setPermissionCheckHandler(() => false);
    } catch {
      /* The private session is being discarded. */
    }
    try {
      item.view.setVisible(false);
    } catch {
      /* The owner may already be closing. */
    }
    if (item.attached) {
      try {
        item.identity.window.contentView.removeChildView(item.view);
      } catch {
        /* The owner may already be closing. */
      }
      item.attached = false;
    }
    if (!item.view.webContents.isDestroyed()) {
      try {
        item.view.webContents.stop();
      } catch {
        /* Destroy below still releases the renderer. */
      }
      try {
        item.view.webContents.close({ waitForBeforeUnload: false });
      } catch {
        /* A destroyed renderer is already clean. */
      }
    }
    void Promise.resolve(item.session.protocol.unhandle(PDF_SCHEME)).catch(() => undefined);
    void item.session.closeAllConnections().catch(() => undefined);
  }

  function close(viewerId: string): void {
    const item = viewers.get(viewerId);
    if (!item) return;
    viewers.delete(viewerId);
    cleanup(item);
  }

  async function open(vaultId: string, relativePath: string): Promise<PdfViewerOpenResult> {
    const owner = options.getOwner();
    if (!owner) return { ok: false, code: 'no-owner' };
    const identity = captureIdentity(owner);
    if (!identity) return { ok: false, code: 'no-owner' };
    const context = options.getContext(vaultId);
    if (!context) return { ok: false, code: 'no-vault' };
    if (context.vaultId !== vaultId || owner.vaultId !== vaultId) return { ok: false, code: 'vault-changed' };

    let managedItem: ManagedPdfViewer | null = null;
    const registry = createPdfResourceRegistry({
      getContext: () => options.getContext(vaultId),
      onUnavailable: (token) => {
        if (
          managedItem &&
          token === managedItem.token &&
          !managedItem.disposed &&
          viewers.get(managedItem.viewerId) === managedItem
        )
          emitState(managedItem, { status: 'unavailable' });
      },
    });
    const issued = await registry.issue(relativePath, vaultId);
    if (!issued.ok) {
      registry.clear();
      return { ok: false, code: issued.code };
    }
    if (!identityIsCurrent(identity, context)) {
      registry.release(issued.token);
      return { ok: false, code: 'vault-changed' };
    }

    const viewerId = options.runtime.createId?.() ?? randomUUID();
    if (!viewerId || viewers.has(viewerId)) {
      registry.release(issued.token);
      return { ok: false, code: 'viewer-unavailable' };
    }
    const partition = `morrow-pdf-${viewerId}`;
    let session: PdfViewerSession | null = null;
    let view: PdfViewerView | null = null;
    let openFailure: PdfViewerOpenError = 'viewer-unavailable';
    try {
      session = options.runtime.createSession(partition, { cache: false });
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => {
        if (typeof callback === 'function') callback(false);
      });
      const initialUrl = PDF_RESOURCE_URL(issued.token);
      const requestListener = (
        details: { readonly url: string },
        callback: (decision: { readonly cancel: boolean }) => void,
      ) => {
        let allowed = details.url === initialUrl;
        if (!allowed) {
          try {
            const url = new URL(details.url);
            allowed =
              url.protocol === 'chrome-extension:' ||
              url.protocol === 'chrome-untrusted:' ||
              (url.protocol === 'chrome:' &&
                url.hostname === 'resources' &&
                !url.username &&
                !url.password &&
                !url.port);
          } catch {
            allowed = false;
          }
        }
        callback({ cancel: !allowed });
      };
      session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, requestListener);
      const protocolHandler = createPdfProtocolHandler({
        getRegistry: () => registry,
        authorize: (_request, token) => token === issued.token && identityIsCurrent(identity, context),
      });
      await session.protocol.handle(PDF_SCHEME, protocolHandler);

      const webPreferences: PdfViewerWebPreferences = {
        session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        plugins: true,
        disableBlinkFeatures: 'FileSystemAccessLocal',
      };
      view = options.runtime.createView({ webPreferences });
      view.setBounds(INITIAL_BOUNDS);
      view.setVisible(false);
      const abort = new AbortController();
      if (!identityIsCurrent(identity, context)) {
        openFailure = 'vault-changed';
        throw new Error('The selected PDF owner changed before loading.');
      }

      const item = {} as ManagedPdfViewer;
      const downloadListener = (event: PdfViewerEvent, file: { cancel(): void }) => {
        event.preventDefault();
        try {
          file.cancel();
        } catch {
          /* A cancelled or completed download has no writable destination. */
        }
      };
      const willNavigateListener = (event: PdfViewerEvent, url: string) => {
        if (url === initialUrl) return;
        event.preventDefault();
        emitExternalLink(item, url);
      };
      const didFinishLoadListener = () => {
        if (!identityIsCurrent(identity, context)) close(viewerId);
      };
      const didFailLoadListener = (
        _event: unknown,
        _errorCode: number,
        _description: string,
        _url: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame && !item.disposed) emitState(item, { status: 'failed' });
      };
      const renderGoneListener = () => {
        if (!item.disposed) emitState(item, { status: 'failed' });
      };
      const foundListener = (_event: unknown, result: PdfFindResult) => {
        if (item.disposed || !identityIsCurrent(identity, context)) return;
        if (item.activeFindRequestId === null) {
          if (item.pendingFindResults.length < 8) item.pendingFindResults.push(result);
          return;
        }
        if (result.requestId !== item.activeFindRequestId) return;
        emitState(item, {
          matches: Number.isSafeInteger(result.matches) && result.matches >= 0 ? result.matches : 0,
          ...(Number.isSafeInteger(result.activeMatchOrdinal) && result.activeMatchOrdinal >= 0
            ? { activeMatchOrdinal: result.activeMatchOrdinal }
            : {}),
        });
      };
      const focusListener = () => {
        if (!item.disposed && item.visible && identityIsCurrent(identity, context))
          safeInvoke(() => options.onFocus?.(viewerId));
      };
      const destroyedListener = () => close(viewerId);
      const closedListener = () => close(viewerId);
      Object.assign(item, {
        viewerId,
        identity,
        context,
        session,
        view,
        registry,
        token: issued.token,
        initialUrl,
        name: path.posix.basename(relativePath),
        size: issued.size,
        abort,
        downloadListener,
        willNavigateListener,
        didFinishLoadListener,
        didFailLoadListener,
        renderGoneListener,
        foundListener,
        focusListener,
        destroyedListener,
        closedListener,
        requestListener,
        state: {
          viewerId,
          sequence: 0,
          status: 'loading',
          name: path.posix.basename(relativePath),
          size: issued.size,
        },
        attached: false,
        visible: false,
        disposed: false,
        lastQuery: null,
        activeFindRequestId: null,
        pendingFindResults: [],
      } satisfies ManagedPdfViewer);
      session.on('will-download', downloadListener);
      view.webContents.setWindowOpenHandler(({ url }) => {
        emitExternalLink(item, url);
        return { action: 'deny' };
      });
      managedItem = item;
      view.webContents.on('will-navigate', willNavigateListener);
      view.webContents.on('did-finish-load', didFinishLoadListener);
      view.webContents.on('did-fail-load', didFailLoadListener);
      view.webContents.on('render-process-gone', renderGoneListener);
      view.webContents.on('found-in-page', foundListener);
      view.webContents.on('focus', focusListener);
      view.webContents.on('destroyed', destroyedListener);
      identity.window.on('closed', closedListener);
      viewers.set(viewerId, item);
      safeInvoke(() => options.onState?.(item.state));
      void view.webContents.loadURL(initialUrl).catch(() => {
        if (!item.disposed) emitState(item, { status: 'failed' });
      });
      void monitorDocument(item);
      return { ok: true, viewerId, state: item.state };
    } catch {
      registry.release(issued.token);
      try {
        session?.webRequest.onBeforeRequest(null);
      } catch {
        /* The private session is being discarded. */
      }
      if (view && !view.webContents.isDestroyed()) {
        try {
          view.webContents.close({ waitForBeforeUnload: false });
        } catch {
          /* Failed setup is already isolated from the app renderer. */
        }
      }
      if (session) {
        try {
          session.setPermissionRequestHandler(() => undefined);
        } catch {
          /* Best-effort cleanup after partial setup. */
        }
        try {
          session.setPermissionCheckHandler(() => false);
        } catch {
          /* Best-effort cleanup after partial setup. */
        }
        try {
          await session.protocol.unhandle(PDF_SCHEME);
        } catch {
          /* Handler may not have registered. */
        }
        void session.closeAllConnections().catch(() => undefined);
      }
      return { ok: false, code: openFailure };
    }
  }

  function present(viewerId: string, bounds: PdfViewerBounds | null, visible: boolean): boolean {
    const item = viewers.get(viewerId);
    if (!item || item.disposed) return false;
    if (!identityIsCurrent(item.identity, item.context)) {
      close(viewerId);
      return false;
    }
    if (!visible) {
      item.visible = false;
      item.view.setVisible(false);
      return true;
    }
    const hide = () => {
      item.visible = false;
      try {
        item.view.setVisible(false);
      } catch {
        /* Keep the native child hidden if bounds cannot be applied. */
      }
      return false;
    };
    if (!bounds || !finiteBounds(bounds)) return hide();
    const windowBounds = item.identity.window.getContentBounds();
    const zoom = item.identity.webContents.getZoomFactor();
    if (
      ![windowBounds.x, windowBounds.y, windowBounds.width, windowBounds.height].every(Number.isFinite) ||
      windowBounds.width <= 0 ||
      windowBounds.height <= 0 ||
      !Number.isFinite(zoom) ||
      zoom <= 0
    )
      return hide();
    const left = Math.max(0, Math.min(windowBounds.width, Math.round(bounds.x * zoom)));
    const top = Math.max(0, Math.min(windowBounds.height, Math.round(bounds.y * zoom)));
    const right = Math.max(0, Math.min(windowBounds.width, Math.round((bounds.x + bounds.width) * zoom)));
    const bottom = Math.max(0, Math.min(windowBounds.height, Math.round((bounds.y + bounds.height) * zoom)));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) return hide();
    try {
      if (!item.attached) {
        item.identity.window.contentView.addChildView(item.view);
        item.attached = true;
      }
      item.view.setBounds({ x: left, y: top, width, height });
      item.view.setVisible(true);
      item.visible = true;
      return true;
    } catch {
      return hide();
    }
  }

  function find(viewerId: string, query: string, forward = true): boolean {
    const item = viewers.get(viewerId);
    if (!item || item.disposed || item.state.status !== 'ready') return false;
    if (!identityIsCurrent(item.identity, item.context)) {
      close(viewerId);
      return false;
    }
    if (typeof query !== 'string' || query.length > MAX_FIND_QUERY_LENGTH) return false;
    if (!query.trim()) {
      item.activeFindRequestId = null;
      item.lastQuery = null;
      item.pendingFindResults = [];
      item.view.webContents.stopFindInPage('clearSelection');
      emitState(item, { matches: 0, activeMatchOrdinal: 0 });
      return true;
    }
    item.pendingFindResults = [];
    item.activeFindRequestId = null;
    const findNext = item.lastQuery !== query;
    emitState(item, { matches: 0, activeMatchOrdinal: 0 });
    try {
      const requestId = item.view.webContents.findInPage(query, {
        forward,
        findNext,
        matchCase: false,
      });
      if (!Number.isSafeInteger(requestId) || requestId < 0) return false;
      item.activeFindRequestId = requestId;
      item.lastQuery = query;
      const pending = item.pendingFindResults;
      item.pendingFindResults = [];
      for (const result of pending) {
        if (result.requestId === requestId) item.foundListener(undefined, result);
      }
      return true;
    } catch {
      return false;
    }
  }

  return {
    open,
    present,
    find,
    getState(viewerId) {
      return viewers.get(viewerId)?.state ?? null;
    },
    close,
    clear() {
      for (const viewerId of [...viewers.keys()]) close(viewerId);
    },
  };
}
