import { WebContentsView, session } from 'electron';
import type { BrowserWindow, DownloadItem, Session, WebContents, WebPreferences } from 'electron';
import { clampBrowserRect, classifyBrowserUrl, isAllowedBrowserDocumentUrl, isAllowedBrowserRequestUrl } from './browserUrlPolicy.js';

export interface BrowserPaneBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function scaleBrowserPaneBounds(bounds: BrowserPaneBounds, zoomFactor: number): BrowserPaneBounds {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  return {
    x: bounds.x * scale,
    y: bounds.y * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

export interface BrowserTabState {
  readonly tabId: string;
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly url: string | null;
  readonly title: string | null;
  readonly target: string;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly warnings: readonly ('http' | 'ephemeral')[];
  readonly error: 'invalid-url' | 'url-too-long' | 'navigation-blocked' | 'load-failed' | null;
  readonly muted: boolean;
  readonly mediaPauseFailed: boolean;
}

type BrowserCommand = 'back' | 'forward' | 'reload' | 'stop';

interface BrowserTabRecord {
  readonly tabId: string;
  readonly view: WebContentsView;
  readonly downloads: Set<DownloadItem>;
  state: Omit<BrowserTabState, 'canGoBack' | 'canGoForward'>;
  bounds: BrowserPaneBounds;
  requestedVisible: boolean;
  actuallyVisible: boolean;
  pauseGeneration: number;
  pausePending: boolean;
}

export interface BrowserResourceManager {
  getState(tabId: string): BrowserTabState;
  navigate(tabId: string, url: string): Promise<BrowserTabState>;
  command(tabId: string, command: BrowserCommand): BrowserTabState;
  setMuted(tabId: string, muted: boolean): BrowserTabState;
  present(tabId: string, bounds: BrowserPaneBounds, visible: boolean): void;
  setOverlaysBlocked(blocked: boolean): void;
  openExternal(tabId: string): string | null;
  release(tabId: string): void;
  releaseAll(): void;
  clearSiteData(): Promise<void>;
  destroy(): Promise<void>;
}

export function isValidBrowserTabId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(value);
}

function restorableTarget(url: string): string {
  const decision = classifyBrowserUrl(url);
  if (!decision.ok || !decision.canRestore) return '#/url/invalid';
  const target = `#/url/${encodeURIComponent(decision.url)}`;
  return target.length <= 8192 ? target : '#/url/invalid';
}

function safeTitle(value: string): string {
  const withoutControls = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f);
    })
    .join('')
    .trim();
  return Array.from(withoutControls).slice(0, 180).join('');
}

function validDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const PAUSE_MEDIA_SCRIPT = `(() => {
  const failures = [];
  for (const media of document.querySelectorAll('audio, video')) {
    try { media.pause(); } catch { failures.push(true); }
  }
  if (failures.length) throw new Error('Some media elements could not be paused.');
  return true;
})()`;

const BROWSER_SESSION_PARTITION = 'persist:morrow-browser-v1';

export function createBrowserResourceManager(options: {
  readonly getWindow: () => BrowserWindow | null;
  readonly onState: (state: BrowserTabState) => void;
  readonly onFocus: (tabId: string) => void;
  readonly createSession?: (partition: string) => Session;
  readonly createView?: (webPreferences: WebPreferences) => WebContentsView;
}): BrowserResourceManager {
  const tabs = new Map<string, BrowserTabRecord>();
  const contentsOwners = new Map<number, BrowserTabRecord>();
  const presentations = new Map<string, { bounds: BrowserPaneBounds; visible: boolean }>();
  const browserSession: Session =
    options.createSession?.(BROWSER_SESSION_PARTITION) ?? session.fromPartition(BROWSER_SESSION_PARTITION, { cache: false });
  let overlaysBlocked = false;
  let destroyed = false;

  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setDevicePermissionHandler(() => false);
  browserSession.setDisplayMediaRequestHandler((_request, callback) => callback(null));

  const onBeforeRequest = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (response: Electron.CallbackResponse) => void,
  ) => {
    const owner = contentsOwners.get(details.webContentsId ?? -1);
    const liveOwner = owner && !destroyed && tabs.get(owner.tabId) === owner &&
      !owner.view.webContents.isDestroyed();
    callback(liveOwner && isAllowedBrowserRequestUrl(details.url, details.resourceType) ? {} : { cancel: true });
  };
  browserSession.webRequest.onBeforeRequest(onBeforeRequest);

  const onWillDownload = (event: Electron.Event, item: DownloadItem, contents: WebContents) => {
    const record = contentsOwners.get(contents.id);
    if (
      !record ||
      record.view.webContents !== contents ||
      !record.actuallyVisible ||
      !item.hasUserGesture() ||
      !validDownloadUrl(item.getURL())
    ) {
      event.preventDefault();
      item.cancel();
      return;
    }
    // Electron's native dialog owns destination selection and supplies its platform title.
    record.downloads.add(item);
    item.once('done', () => record.downloads.delete(item));
  };
  browserSession.on('will-download', onWillDownload);

  function stateOf(record: BrowserTabRecord): BrowserTabState {
    const contents = record.view.webContents;
    const alive = !contents.isDestroyed();
    return {
      ...record.state,
      canGoBack: alive && contents.canGoBack(),
      canGoForward: alive && contents.canGoForward(),
    };
  }

  function emit(record: BrowserTabRecord): BrowserTabState {
    const state = stateOf(record);
    options.onState(state);
    return state;
  }

  function blankState(tabId: string): BrowserTabState {
    return {
      tabId,
      status: 'idle',
      url: null,
      title: null,
      target: '#/url/invalid',
      canGoBack: false,
      canGoForward: false,
      warnings: [],
      error: null,
      muted: true,
      mediaPauseFailed: false,
    };
  }

  async function pauseMediaAcrossFrames(record: BrowserTabRecord): Promise<boolean> {
    const contents = record.view.webContents;
    if (contents.isDestroyed()) return false;
    let frames: Electron.WebFrameMain[];
    try {
      frames = contents.mainFrame.framesInSubtree;
    } catch {
      return false;
    }
    const results = await Promise.all(
      frames.map(async (frame) => {
        if (frame.detached) return true;
        try {
          await frame.executeJavaScript(PAUSE_MEDIA_SCRIPT);
          return true;
        } catch {
          return false;
        }
      }),
    );
    return results.length > 0 && results.every(Boolean);
  }

  function pauseMediaAfterHide(record: BrowserTabRecord): void {
    const generation = ++record.pauseGeneration;
    record.pausePending = true;
    void pauseMediaAcrossFrames(record).then((paused) => {
      if (tabs.get(record.tabId) !== record || record.pauseGeneration !== generation) return;
      record.pausePending = false;
      setState(record, { mediaPauseFailed: !paused });
    });
  }

  function updateVisibility(record: BrowserTabRecord): void {
    const window = options.getWindow();
    const canShow = Boolean(
      !destroyed &&
        window &&
        !window.isDestroyed() &&
        record.requestedVisible &&
        !overlaysBlocked &&
        record.bounds.width > 0 &&
        record.bounds.height > 0 &&
        !record.view.webContents.isDestroyed(),
    );
    if (canShow && window && !window.isDestroyed()) {
      const content = window.getContentBounds();
      const bounds = clampBrowserRect(record.bounds, content);
      record.view.setBounds(bounds);
    } else {
      record.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    if (record.actuallyVisible === canShow) return;
    record.actuallyVisible = canShow;
    record.view.setVisible(canShow);
    if (!canShow) {
      record.view.webContents.setAudioMuted(true);
      setState(record, { muted: true });
      if (!record.view.webContents.isDestroyed()) pauseMediaAfterHide(record);
    }
  }

  function setState(
    record: BrowserTabRecord,
    patch: Partial<BrowserTabRecord['state']>,
    publish = true,
  ): BrowserTabState {
    record.state = { ...record.state, ...patch };
    return publish ? emit(record) : stateOf(record);
  }

  function recordNavigation(record: BrowserTabRecord, url: string): void {
    const decision = classifyBrowserUrl(url);
    if (!decision.ok) {
      setState(record, { status: 'error', error: 'navigation-blocked' });
      return;
    }
    setState(record, {
      status: 'ready',
      url: decision.url,
      target: restorableTarget(decision.url),
      warnings: decision.warnings,
      error: null,
      title: safeTitle(record.view.webContents.getTitle()) || null,
    });
  }

  function makeRecord(tabId: string): BrowserTabRecord | null {
    const window = options.getWindow();
    if (destroyed || !window || window.isDestroyed() || !isValidBrowserTabId(tabId)) return null;
    const webPreferences: WebPreferences = {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      disableBlinkFeatures: 'FileSystemAccessLocal',
      autoplayPolicy: 'document-user-activation-required',
    };
    const view = options.createView
      ? options.createView(webPreferences)
      : new WebContentsView({ webPreferences });
    const webContentsId = view.webContents.id;
    const presentation = presentations.get(tabId);
    const record: BrowserTabRecord = {
      tabId,
      view,
      downloads: new Set(),
      state: {
        ...blankState(tabId),
      },
      bounds: presentation?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
      requestedVisible: presentation?.visible ?? false,
      actuallyVisible: false,
      pauseGeneration: 0,
      pausePending: false,
    };
    window.contentView.addChildView(view);
    view.setVisible(false);
    view.webContents.setAudioMuted(true);
    tabs.set(tabId, record);
    contentsOwners.set(webContentsId, record);

    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('before-input-event', (_event, input) => {
      if (
        record.actuallyVisible &&
        !record.pausePending &&
        !record.state.mediaPauseFailed &&
        input.type === 'keyDown'
      ) {
        view.webContents.setAudioMuted(false);
        setState(record, { muted: false });
      }
    });
    view.webContents.on('before-mouse-event', (_event, mouse) => {
      if (
        record.actuallyVisible &&
        !record.pausePending &&
        !record.state.mediaPauseFailed &&
        mouse.type === 'mouseDown' &&
        mouse.button === 'left'
      ) {
        view.webContents.setAudioMuted(false);
        setState(record, { muted: false });
      }
    });
    view.webContents.on('focus', () => {
      if (record.actuallyVisible && tabs.get(tabId) === record) options.onFocus(tabId);
    });
    view.webContents.on('will-frame-navigate', (details) => {
      if (isAllowedBrowserDocumentUrl(details.url)) return;
      details.preventDefault();
      setState(record, { status: 'error', error: 'navigation-blocked' });
    });
    view.webContents.on('will-redirect', (details) => {
      if (isAllowedBrowserDocumentUrl(details.url)) return;
      details.preventDefault();
      setState(record, { status: 'error', error: 'navigation-blocked' });
    });
    view.webContents.on('did-start-loading', () => {
      setState(record, { status: 'loading', error: null });
    });
    view.webContents.on('did-stop-loading', () => {
      if (record.state.status === 'loading')
        setState(record, { status: record.state.url ? 'ready' : 'idle' });
    });
    view.webContents.on('did-navigate', (_event, url) => recordNavigation(record, url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) recordNavigation(record, url);
    });
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      setState(record, { title: safeTitle(title) || null });
    });
    view.webContents.on('did-fail-load', (_event, errorCode) => {
      if (errorCode === -3) return;
      setState(record, { status: 'error', error: 'load-failed' });
    });
    view.webContents.on('render-process-gone', () => {
      setState(record, { status: 'error', error: 'load-failed' });
    });
    view.webContents.on('will-prevent-unload', (event) => event.preventDefault());
    view.webContents.on('destroyed', () => {
      contentsOwners.delete(webContentsId);
      if (tabs.get(tabId) === record) tabs.delete(tabId);
    });
    updateVisibility(record);
    return record;
  }

  function ensureRecord(tabId: string): BrowserTabRecord | null {
    return tabs.get(tabId) ?? makeRecord(tabId);
  }

  function cancelDownloads(record: BrowserTabRecord): void {
    for (const download of record.downloads) {
      try {
        download.cancel();
      } catch {
        // A completed download has already left the item lifecycle.
      }
    }
    record.downloads.clear();
  }

  function releaseRecord(tabId: string, clearPresentation: boolean): void {
    const record = tabs.get(tabId);
    if (clearPresentation) presentations.delete(tabId);
    if (!record) return;
    tabs.delete(tabId);
    contentsOwners.delete(record.view.webContents.id);
    cancelDownloads(record);
    const window = options.getWindow();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(record.view);
    record.view.setVisible(false);
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false });
    options.onState(blankState(tabId));
  }

  function release(tabId: string): void {
    releaseRecord(tabId, true);
  }

  function releaseAll(): void {
    for (const tabId of [...tabs.keys()]) release(tabId);
  }

  return {
    getState(tabId) {
      const record = tabs.get(tabId);
      return record ? stateOf(record) : blankState(tabId);
    },

    async navigate(tabId, value) {
      const decision = classifyBrowserUrl(value);
      if (!decision.ok) {
        const state = blankState(tabId);
        const result = { ...state, status: 'error' as const, error: decision.code };
        options.onState(result);
        return result;
      }
      const record = ensureRecord(tabId);
      if (!record) {
        const result = { ...blankState(tabId), status: 'error' as const, error: 'load-failed' as const };
        options.onState(result);
        return result;
      }
      setState(record, {
        status: 'loading',
        url: decision.url,
        target: restorableTarget(decision.url),
        title: null,
        warnings: decision.warnings,
        error: null,
        muted: true,
        mediaPauseFailed: false,
      });
      record.pauseGeneration += 1;
      record.pausePending = false;
      record.view.webContents.setAudioMuted(true);
      updateVisibility(record);
      try {
        await record.view.webContents.loadURL(decision.url);
      } catch {
        if (tabs.get(tabId) === record)
          setState(record, { status: 'error', error: 'load-failed' });
      }
      if (tabs.get(tabId) !== record) return blankState(tabId);
      return stateOf(record);
    },

    command(tabId, command) {
      const record = tabs.get(tabId);
      if (!record || record.view.webContents.isDestroyed()) return blankState(tabId);
      const contents = record.view.webContents;
      if (command === 'back' && contents.canGoBack()) contents.goBack();
      else if (command === 'forward' && contents.canGoForward()) contents.goForward();
      else if (command === 'reload' && record.state.url) contents.reload();
      else if (command === 'stop') contents.stop();
      return emit(record);
    },

    setMuted(tabId, muted) {
      const record = tabs.get(tabId);
      if (!record || record.view.webContents.isDestroyed()) return blankState(tabId);
      if (!muted && (!record.actuallyVisible || record.pausePending || record.state.mediaPauseFailed))
        return emit(record);
      record.view.webContents.setAudioMuted(muted);
      return setState(record, { muted });
    },

    present(tabId, bounds, visible) {
      if (!isValidBrowserTabId(tabId)) return;
      presentations.set(tabId, { bounds, visible });
      const record = tabs.get(tabId);
      if (!record) return;
      record.bounds = bounds;
      record.requestedVisible = visible;
      updateVisibility(record);
    },

    setOverlaysBlocked(blocked) {
      overlaysBlocked = blocked;
      for (const record of tabs.values()) updateVisibility(record);
    },

    openExternal(tabId) {
      const record = tabs.get(tabId);
      if (!record || record.view.webContents.isDestroyed()) return null;
      const current = record.view.webContents.getURL();
      const decision = classifyBrowserUrl(current);
      return decision.ok ? decision.url : null;
    },

    release,
    releaseAll,

    async clearSiteData() {
      for (const tabId of [...tabs.keys()]) releaseRecord(tabId, false);
      await browserSession.closeAllConnections().catch(() => undefined);
      await browserSession.clearData();
      await browserSession.clearAuthCache();
    },

    async destroy() {
      if (destroyed) return;
      destroyed = true;
      releaseAll();
      browserSession.removeListener('will-download', onWillDownload);
      browserSession.webRequest.onBeforeRequest(null);
    },
  };
}
