import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  session: { fromPartition: vi.fn() },
  WebContentsView: class {},
}));

import { createBrowserResourceManager, scaleBrowserPaneBounds } from './browserResources.js';
import type { BrowserTabState } from './browserResources.js';
import type { BrowserWindow, DownloadItem, Session, WebContents, WebContentsView, WebPreferences } from 'electron';

class FakeContents extends EventEmitter {
  readonly id: number;
  readonly mediaPause = vi.fn();
  private createFrame() {
    const context = createContext({ document: { querySelectorAll: () => [{ pause: this.mediaPause }] } });
    return {
      detached: false,
      executeJavaScript: vi.fn(async (script: string) => runInContext(script, context)),
    };
  }
  readonly mainFrame = {
    framesInSubtree: [this.createFrame(), this.createFrame()],
  };
  readonly loadURL = vi.fn(async (url: string) => {
    this.url = url;
    this.emit('did-start-loading');
    this.emit('did-navigate', {}, url);
  });
  readonly executeJavaScript = vi.fn(async () => true);
  readonly setAudioMuted = vi.fn();
  readonly setWindowOpenHandler = vi.fn((handler: () => { action: 'deny' }) => {
    this.windowOpenHandler = handler;
  });
  readonly goBack = vi.fn();
  readonly goForward = vi.fn();
  readonly reload = vi.fn();
  readonly stop = vi.fn();
  private destroyed = false;
  private url = '';
  private title = '';
  windowOpenHandler: (() => { action: 'deny' }) | null = null;
  readonly close = vi.fn((_options?: { waitForBeforeUnload?: boolean }) => {
    this.destroyed = true;
    this.emit('destroyed');
  });

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed() {
    return this.destroyed;
  }
  canGoBack() {
    return false;
  }
  canGoForward() {
    return false;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.title;
  }
}

class FakeView {
  readonly webContents: FakeContents;
  readonly setVisible = vi.fn();
  readonly setBounds = vi.fn();

  constructor(id: number) {
    this.webContents = new FakeContents(id);
  }
}

class FakeSession extends EventEmitter {
  readonly webRequest = {
    listener: null as ((details: { url: string; resourceType: string; webContentsId?: number }, callback: (result: unknown) => void) => void) | null,
    onBeforeRequest: vi.fn((listener: FakeSession['webRequest']['listener']) => {
      this.webRequest.listener = listener;
    }),
  };
  readonly setPermissionCheckHandler = vi.fn();
  readonly setPermissionRequestHandler = vi.fn();
  readonly setDevicePermissionHandler = vi.fn();
  readonly setDisplayMediaRequestHandler = vi.fn();
  readonly clearData = vi.fn(async () => undefined);
  readonly clearAuthCache = vi.fn(async () => undefined);
  readonly closeAllConnections = vi.fn(async () => undefined);
}

describe('browser resource manager', () => {
  let browserSession: FakeSession;
  let views: FakeView[];
  let preferences: WebPreferences[];
  let removed: unknown[];
  let added: unknown[];
  let partition: string;
  let manager: ReturnType<typeof createBrowserResourceManager>;
  let window: BrowserWindow;
  let onState: (state: BrowserTabState) => void;
  let onFocus: (tabId: string) => void;

  beforeEach(() => {
    browserSession = new FakeSession();
    views = [];
    preferences = [];
    removed = [];
    added = [];
    onState = vi.fn<(state: BrowserTabState) => void>();
    onFocus = vi.fn<(tabId: string) => void>();
    partition = '';
    window = {
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
      contentView: {
        addChildView: (view: unknown) => added.push(view),
        removeChildView: (view: unknown) => removed.push(view),
      },
    } as unknown as BrowserWindow;
    let nextId = 0;
    manager = createBrowserResourceManager({
      getWindow: () => window,
      onState,
      onFocus,
      createSession: (name) => {
        partition = name;
        return browserSession as unknown as Session;
      },
      createView: (webPreferences) => {
        preferences.push(webPreferences);
        const view = new FakeView(++nextId);
        views.push(view);
        return view as unknown as WebContentsView;
      },
    });
  });

  it('converts CSS pane rectangles to native bounds using the app zoom factor', () => {
    expect(scaleBrowserPaneBounds({ x: 20, y: 30, width: 320, height: 220 }, 1.25)).toEqual({
      x: 25,
      y: 37.5,
      width: 400,
      height: 275,
    });
    expect(scaleBrowserPaneBounds({ x: 20, y: 30, width: 320, height: 220 }, Number.NaN)).toEqual({
      x: 20,
      y: 30,
      width: 320,
      height: 220,
    });
  });

  it('denies requests without a live owning web tab, including requests after the last tab closes', async () => {
    const request = (webContentsId?: number, url = 'https://example.com/background') => {
      const reply = vi.fn();
      browserSession.webRequest.listener!({ url, resourceType: 'xhr', webContentsId }, reply);
      return reply;
    };
    expect(request()).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    await manager.navigate('tab-a', 'https://example.com/');
    const id = views[0]!.webContents.id;
    expect(request(id)).toHaveBeenCalledExactlyOnceWith({});
    expect(request(id + 1)).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(request(id, 'file:///synthetic.txt')).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    manager.release('tab-a');
    expect(request(id)).toHaveBeenCalledExactlyOnceWith({ cancel: true });
    expect(request()).toHaveBeenCalledExactlyOnceWith({ cancel: true });
  });

  it('uses the dedicated persistent browser session and strict web preferences without creating pages until asked', async () => {
    expect(partition).toBe('persist:morrow-browser-v1');
    expect(partition).not.toBe('default');
    expect(partition).not.toMatch(/^morrow-(?:pdf|image)-/u);
    expect(browserSession.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(browserSession.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(browserSession.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(browserSession.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
    expect(views).toHaveLength(0);

    const invalid = await manager.navigate('tab-a', 'file:///synthetic.txt');
    expect(invalid.error).toBe('invalid-url');
    expect(views).toHaveLength(0);
    await manager.navigate('tab-a', 'https://example.com/?token=synthetic-secret');
    expect(preferences[0]).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      disableBlinkFeatures: 'FileSystemAccessLocal',
      autoplayPolicy: 'document-user-activation-required',
    });
    expect('preload' in preferences[0]!).toBe(false);
    expect(views[0]?.webContents.getURL()).toBe('https://example.com/?token=synthetic-secret');
    expect(manager.getState('tab-a')).toMatchObject({
      target: '#/url/invalid',
      warnings: ['ephemeral'],
      url: 'https://example.com/?token=synthetic-secret',
    });
  });

  it('clamps native bounds, synchronously hides on obstruction, and never resumes audio automatically', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const view = views[0]!;
    manager.present('tab-a', { x: 100, y: 20, width: 1000, height: 800 }, true);
    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 100, y: 20, width: 800, height: 680 });
    expect(view.setVisible).toHaveBeenLastCalledWith(true);

    vi.mocked(onState).mockClear();
    manager.setOverlaysBlocked(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    const frames = (view.webContents as unknown as FakeContents).mainFrame.framesInSubtree;
    await vi.waitFor(() => {
      expect(frames[0]?.executeJavaScript).toHaveBeenCalledOnce();
      expect(frames[1]?.executeJavaScript).toHaveBeenCalledOnce();
      expect(vi.mocked(onState).mock.calls).toHaveLength(2);
    });
    manager.setOverlaysBlocked(false);
    expect(view.setVisible).toHaveBeenLastCalledWith(true);
    expect(view.webContents.setAudioMuted).not.toHaveBeenLastCalledWith(false);
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' });
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
  });

  it('reports native focus only for a currently visible browser tab', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const contents = views[0]!.webContents;
    contents.emit('focus');
    expect(onFocus).not.toHaveBeenCalled();

    manager.present('tab-a', { x: 0, y: 0, width: 320, height: 240 }, true);
    contents.emit('focus');
    expect(onFocus).toHaveBeenCalledOnce();
    expect(onFocus).toHaveBeenLastCalledWith('tab-a');

    manager.present('tab-a', { x: 0, y: 0, width: 0, height: 0 }, false);
    contents.emit('focus');
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it('uses stop-loading to leave the busy state and keeps cleared panes restoreable only on request', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const view = views[0]!;
    view.webContents.emit('did-start-loading');
    expect(manager.getState('tab-a').status).toBe('loading');
    manager.command('tab-a', 'stop');
    view.webContents.emit('did-stop-loading');
    expect(manager.getState('tab-a').status).toBe('ready');

    manager.present('tab-a', { x: 20, y: 30, width: 320, height: 220 }, true);
    await manager.clearSiteData();
    expect(manager.getState('tab-a')).toMatchObject({ status: 'idle', url: null });
    await manager.navigate('tab-a', 'https://example.com/');
    expect(views[1]?.setVisible).toHaveBeenLastCalledWith(true);
    expect(views[1]?.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 320, height: 220 });
  });

  it('keeps a tab muted when pausing any child frame fails', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const view = views[0]!;
    manager.present('tab-a', { x: 0, y: 0, width: 300, height: 200 }, true);
    const frames = (view.webContents as unknown as FakeContents).mainFrame.framesInSubtree;
    frames[1]!.executeJavaScript.mockRejectedValueOnce(new Error('synthetic frame failure'));

    manager.setOverlaysBlocked(true);
    await vi.waitFor(() => expect(manager.getState('tab-a').mediaPauseFailed).toBe(true));
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    manager.setOverlaysBlocked(false);
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left' });
    expect(view.webContents.setAudioMuted).not.toHaveBeenLastCalledWith(false);
    expect(manager.getState('tab-a').muted).toBe(true);
  });

  it('can pause media repeatedly in the same frame execution context', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const view = views[0]!;
    manager.present('tab-a', { x: 0, y: 0, width: 300, height: 200 }, true);

    manager.setOverlaysBlocked(true);
    const frames = (view.webContents as unknown as FakeContents).mainFrame.framesInSubtree;
    await vi.waitFor(() => {
      expect(frames[0]?.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(frames[1]?.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(manager.getState('tab-a').mediaPauseFailed).toBe(false);
    });

    manager.setOverlaysBlocked(false);
    manager.setOverlaysBlocked(true);
    await vi.waitFor(() => {
      expect(frames[0]?.executeJavaScript).toHaveBeenCalledTimes(2);
      expect(frames[1]?.executeJavaScript).toHaveBeenCalledTimes(2);
      expect(manager.getState('tab-a').mediaPauseFailed).toBe(false);
    });
    await vi.waitFor(() => expect((view.webContents as unknown as FakeContents).mediaPause).toHaveBeenCalledTimes(4));
  });

  it('denies popups and prevents navigation and redirects to local or privileged schemes', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const contents = views[0]!.webContents;
    expect(contents.windowOpenHandler?.()).toEqual({ action: 'deny' });

    const localNavigation = { url: 'morrow-file://vault/secret.md', preventDefault: vi.fn() };
    contents.emit('will-frame-navigate', localNavigation);
    expect(localNavigation.preventDefault).toHaveBeenCalledOnce();
    expect(manager.getState('tab-a').error).toBe('navigation-blocked');

    const privilegedRedirect = { url: 'javascript:synthetic()', preventDefault: vi.fn() };
    contents.emit('will-redirect', privilegedRedirect);
    expect(privilegedRedirect.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies downloads without a real gesture and cancels active downloads when the tab releases', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    manager.present('tab-a', { x: 0, y: 0, width: 300, height: 200 }, true);
    const contents = views[0]!.webContents;
    const item = (gesture: boolean) => Object.assign(new EventEmitter(), {
      hasUserGesture: () => gesture,
      getURL: () => 'https://example.com/download.bin',
      setSaveDialogOptions: vi.fn(),
      cancel: vi.fn(),
    }) as unknown as DownloadItem;
    const automatic = item(false);
    const rejectedEvent = { preventDefault: vi.fn() };
    browserSession.emit('will-download', rejectedEvent, automatic, contents as unknown as WebContents);
    expect(rejectedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(automatic.cancel).toHaveBeenCalledOnce();
    expect(automatic.setSaveDialogOptions).not.toHaveBeenCalled();

    const explicit = item(true);
    const acceptedEvent = { preventDefault: vi.fn() };
    browserSession.emit('will-download', acceptedEvent, explicit, contents as unknown as WebContents);
    expect(acceptedEvent.preventDefault).not.toHaveBeenCalled();
    expect(explicit.cancel).not.toHaveBeenCalled();
    expect(explicit.setSaveDialogOptions).not.toHaveBeenCalled();
    manager.release('tab-a');
    expect(explicit.cancel).toHaveBeenCalledOnce();
    expect(removed).toHaveLength(1);
    expect(contents.isDestroyed()).toBe(true);
    expect((contents as unknown as FakeContents).close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it('releases safely when the native view no longer exposes its destroyed webContents', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    const view = views[0]!;
    const contents = view.webContents;
    Object.defineProperty(view, 'webContents', {
      get: () => contents.isDestroyed() ? undefined : contents,
    });

    expect(() => manager.release('tab-a')).not.toThrow();
    expect(contents.isDestroyed()).toBe(true);
    expect(manager.getState('tab-a').status).toBe('idle');
    expect(removed).toHaveLength(1);
  });

  it('preserves site data on tab and vault release and clears it only on explicit request', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    await manager.navigate('tab-b', 'https://example.org/');
    manager.releaseAll();
    expect(removed).toHaveLength(2);
    expect(browserSession.closeAllConnections).not.toHaveBeenCalled();
    expect(browserSession.clearData).not.toHaveBeenCalled();
    expect(browserSession.clearAuthCache).not.toHaveBeenCalled();
    expect(manager.getState('tab-a').status).toBe('idle');

    await manager.navigate('tab-a', 'https://example.com/');
    await manager.clearSiteData();
    expect(removed).toHaveLength(3);
    expect(browserSession.closeAllConnections).toHaveBeenCalledOnce();
    expect(browserSession.clearData).toHaveBeenCalledOnce();
    expect(browserSession.clearAuthCache).toHaveBeenCalledOnce();
    expect(manager.getState('tab-a').status).toBe('idle');
  });

  it('destroys views without clearing persistent browser data implicitly', async () => {
    await manager.navigate('tab-a', 'https://example.com/');
    await manager.destroy();

    expect(removed).toHaveLength(1);
    expect(views[0]?.webContents.isDestroyed()).toBe(true);
    expect(browserSession.closeAllConnections).not.toHaveBeenCalled();
    expect(browserSession.clearData).not.toHaveBeenCalled();
    expect(browserSession.clearAuthCache).not.toHaveBeenCalled();
  });
});
