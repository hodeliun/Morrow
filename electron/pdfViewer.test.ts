import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfViewerManager, PDF_FRAME_SNAPSHOT } from './pdfViewer.js';
import type {
  PdfViewerBounds,
  PdfViewerFrame,
  PdfViewerOwner,
  PdfViewerRuntime,
  PdfViewerSession,
  PdfViewerState,
  PdfViewerView,
  PdfViewerWebContents,
  PdfViewerWebPreferences,
  PdfViewerWindow,
} from './pdfViewer.js';
import type { PdfVaultContext } from './pdfResources.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'morrow-pdf-viewer-')));
  roots.push(root);
  return root;
}

function makePdf(root: string, name = 'selected.pdf'): string {
  const documents = path.join(root, 'Documents');
  mkdirSync(documents, { recursive: true });
  const file = path.join(documents, name);
  writeFileSync(file, Buffer.from('%PDF-1.7\nsynthetic selected document\n%%EOF\n'), { flag: 'wx' });
  return file;
}

interface Snapshot {
  status: 'loading' | 'ready' | 'invalid' | 'password-required';
  pageCount?: number;
}

class MockFrame {
  readonly processId = 20;
  readonly routingId = 30;
  readonly frameTreeNodeId = 40;
  readonly url = 'chrome-extension://pdf-viewer/index.html';
  private snapshot: Snapshot;
  dead = false;

  constructor(snapshot: Snapshot) {
    this.snapshot = snapshot;
  }
  get framesInSubtree(): PdfViewerFrame[] {
    return [this as unknown as PdfViewerFrame];
  }
  isDestroyed(): boolean {
    return this.dead;
  }
  async executeJavaScript(): Promise<unknown> {
    return { ...this.snapshot };
  }
  setSnapshot(snapshot: Snapshot): void {
    this.snapshot = snapshot;
  }
}

class MockSession {
  readonly protocol = {
    handlers: new Map<string, (request: Request) => Promise<Response>>(),
    handle: vi.fn(async (scheme: string, handler: (request: Request) => Promise<Response>) => {
      this.protocol.handlers.set(scheme, handler);
    }),
    unhandle: vi.fn(async (scheme: string) => {
      this.protocol.handlers.delete(scheme);
    }),
  };
  readonly webRequest = {
    filter: null as { readonly urls: string[] } | null,
    listener: null as
      | ((
          details: { readonly url: string },
          callback: (decision: { readonly cancel: boolean }) => void,
        ) => void)
      | null,
    onBeforeRequest: vi.fn(
      (
        filter: { readonly urls: string[] } | null,
        listener?: (
          details: { readonly url: string },
          callback: (decision: { readonly cancel: boolean }) => void,
        ) => void,
      ) => {
        this.webRequest.filter = filter;
        this.webRequest.listener = listener ?? null;
      },
    ),
  };
  readonly emitter = new EventEmitter();
  permissionRequest: ((...args: unknown[]) => void) | null = null;
  permissionCheck: ((...args: unknown[]) => boolean) | null = null;
  closeAllConnections = vi.fn(async () => undefined);
  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);
  setPermissionRequestHandler = vi.fn((handler: (...args: unknown[]) => void) => {
    this.permissionRequest = handler;
  });
  setPermissionCheckHandler = vi.fn((handler: (...args: unknown[]) => boolean) => {
    this.permissionCheck = handler;
  });
}

class MockWebContents {
  readonly id: number;
  readonly session: MockSession;
  readonly mainFrame: MockFrame;
  readonly emitter = new EventEmitter();
  dead = false;
  zoom = 1;
  loadUrl: string | null = null;
  findCalls: Array<{ text: string; options: { forward: boolean; findNext: boolean; matchCase: boolean } }> =
    [];
  stopFindInPage = vi.fn();
  close = vi.fn(() => {
    this.dead = true;
    this.emitter.emit('destroyed');
  });
  stop = vi.fn();
  findInPage = vi.fn((text: string, options: { forward: boolean; findNext: boolean; matchCase: boolean }) => {
    this.findCalls.push({ text, options });
    return this.findCalls.length;
  });
  windowOpenHandler: ((details: { readonly url: string }) => { readonly action: 'deny' }) | null = null;

  constructor(id: number, session: MockSession, snapshot: Snapshot = { status: 'ready', pageCount: 2 }) {
    this.id = id;
    this.session = session;
    this.mainFrame = new MockFrame(snapshot);
  }

  isDestroyed(): boolean {
    return this.dead;
  }
  getZoomFactor(): number {
    return this.zoom;
  }
  async loadURL(url: string): Promise<void> {
    this.loadUrl = url;
  }
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void {
    this.windowOpenHandler = handler;
  }
  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);
}

class MockView {
  readonly webContents: MockWebContents;
  bounds: PdfViewerBounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = false;
  setBounds = vi.fn((bounds: PdfViewerBounds) => {
    this.bounds = bounds;
  });
  setVisible = vi.fn((visible: boolean) => {
    this.visible = visible;
  });
  constructor(webContents: MockWebContents) {
    this.webContents = webContents;
  }
}

class MockWindow {
  readonly emitter = new EventEmitter();
  readonly contentView = {
    views: [] as PdfViewerView[],
    addChildView: vi.fn((view: PdfViewerView) => {
      this.contentView.views.push(view);
    }),
    removeChildView: vi.fn((view: PdfViewerView) => {
      this.contentView.views = this.contentView.views.filter((candidate) => candidate !== view);
    }),
  };
  dead = false;
  bounds = { x: 0, y: 0, width: 640, height: 480 };
  isDestroyed(): boolean {
    return this.dead;
  }
  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return this.bounds;
  }
  on = this.emitter.on.bind(this.emitter);
  off = this.emitter.off.bind(this.emitter);
}

function makeManager(options: {
  readonly root: string;
  readonly snapshot?: Snapshot;
  readonly delay?: (delayMs: number) => Promise<void>;
  readonly onState?: (state: PdfViewerState) => void;
  readonly onFocus?: (viewerId: string) => void;
  readonly onExternalLink?: (viewerId: string, url: string) => void;
}) {
  const window = new MockWindow();
  const ownerSession = new MockSession();
  const ownerContents = new MockWebContents(1, ownerSession);
  const owner: PdfViewerOwner = {
    window: window as unknown as PdfViewerWindow,
    webContents: ownerContents as unknown as PdfViewerWebContents,
    vaultId: 'vault-a',
  };
  const context: PdfVaultContext = {
    root: options.root,
    realRoot: options.root,
    generation: 1,
    vaultId: 'vault-a',
  };
  const sessions: MockSession[] = [];
  const views: MockView[] = [];
  const webContents: MockWebContents[] = [];
  let nextId = 0;
  const runtime: PdfViewerRuntime = {
    createSession: () => {
      const session = new MockSession();
      sessions.push(session);
      return session as unknown as PdfViewerSession;
    },
    createView: ({ webPreferences }: { readonly webPreferences: PdfViewerWebPreferences }) => {
      expect(webPreferences).toMatchObject({
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        plugins: true,
        disableBlinkFeatures: 'FileSystemAccessLocal',
      });
      const session = webPreferences.session as unknown as MockSession;
      const contents = new MockWebContents(
        2 + views.length,
        session,
        options.snapshot ?? { status: 'ready', pageCount: 2 },
      );
      webContents.push(contents);
      const view = new MockView(contents);
      views.push(view);
      return view as unknown as PdfViewerView;
    },
    getAllWebContents: () => [...webContents] as unknown as PdfViewerWebContents[],
    createId: () => `pdf-viewer-${++nextId}`,
    delay: options.delay,
  };
  const manager = createPdfViewerManager({
    runtime,
    getOwner: () => owner,
    getContext: (vaultId) => (vaultId === context.vaultId ? context : null),
    onState: options.onState,
    onFocus: options.onFocus,
    onExternalLink: options.onExternalLink,
    readinessTimeoutMs: 100,
    frameEvaluationBudgetMs: 10,
    framePollIntervalMs: 1,
  });
  return { manager, owner, ownerContents, context, window, sessions, views, webContents };
}

async function waitForState(
  manager: ReturnType<typeof makeManager>['manager'],
  viewerId: string,
  expected: PdfViewerState['status'],
): Promise<PdfViewerState> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const state = manager.getState(viewerId);
    if (state?.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for PDF viewer state ${expected}.`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PDF viewer manager', () => {
  it('recognizes the open native password dialog through a zero-height host without reading its input', () => {
    const input = {
      get value(): never {
        throw new Error('A password value must never be read.');
      },
    };
    const nativeDialog = {
      open: true,
      hidden: false,
      isConnected: true,
      getBoundingClientRect: () => ({ width: 320, height: 160 }),
    };
    const nativeShadow = {
      querySelectorAll: (selector: string) =>
        selector === 'dialog' ? [nativeDialog] : [nativeDialog, input],
    };
    const dialog = {
      isConnected: true,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 1176, height: 0 }),
      shadowRoot: {
        querySelectorAll: (selector: string) => (selector === 'dialog' ? [] : [{ shadowRoot: nativeShadow }]),
      },
    };
    let protectedFile = true;
    const plugin = {
      isConnected: true,
      getAttribute: () => 'application/x-google-chrome-pdf',
      getBoundingClientRect: () => ({ width: 875, height: 777 }),
    };
    const viewer = {
      loadState_: 'loading',
      loadProgress_: 0,
      docLength_: 0,
      documentDimensions: { pageDimensions: [] as { width: number; height: number }[] },
      shadowRoot: {
        querySelector: (selector: string) =>
          selector.startsWith('viewer-password-dialog')
            ? protectedFile
              ? dialog
              : null
            : selector === '#plugin'
              ? plugin
              : null,
      },
    };
    const context = { document: { querySelector: () => viewer } };
    expect(runInNewContext(PDF_FRAME_SNAPSHOT, context)).toMatchObject({ status: 'password-required' });
    nativeDialog.open = false;
    expect(runInNewContext(PDF_FRAME_SNAPSHOT, context)).toMatchObject({ status: 'loading' });
    protectedFile = false;
    viewer.loadState_ = 'success';
    viewer.loadProgress_ = 100;
    viewer.docLength_ = 2;
    viewer.documentDimensions.pageDimensions = [
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ];
    expect(runInNewContext(PDF_FRAME_SNAPSHOT, context)).toMatchObject({ status: 'ready', pageCount: 2 });
  });

  it('loads Chromium PDF dependencies only from the built-in resources host', async () => {
    const root = makeRoot();
    makePdf(root);
    const harness = makeManager({ root });
    try {
      const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
      expect(opened.ok).toBe(true);
      const decide = (url: string) => {
        const decisions: { cancel: boolean }[] = [];
        harness.sessions[0]!.webRequest.listener?.({ url }, (decision) => decisions.push(decision));
        return decisions;
      };
      for (const pathname of [
        'css/text_defaults_md.css',
        'lit/v3_0/lit.rollup.js',
        'js/load_time_data.js',
        'mojo/mojo/public/js/bindings.js',
        'js/assert.js',
      ])
        expect(decide(`chrome://resources/${pathname}`), pathname).toEqual([{ cancel: false }]);
      for (const url of [
        'chrome://settings/',
        'chrome://downloads/',
        'chrome://resources.evil/js/assert.js',
        'chrome://resources:443/js/assert.js',
        'chrome://user:pass@resources/js/assert.js',
        'https://resources/js/assert.js',
        'file:///private/document.pdf',
        'ws://example.test/',
      ])
        expect(decide(url), url).toEqual([{ cancel: true }]);
    } finally {
      harness.manager.clear();
    }
  });

  it('opens only the selected capability in a hidden hardened memory session', async () => {
    const root = makeRoot();
    makePdf(root);
    const harness = makeManager({ root });
    const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Expected the selected PDF viewer to open.');
    const session = harness.sessions[0]!;
    const view = harness.views[0]!;
    const contents = harness.webContents[0]!;

    expect(session.protocol.handle).toHaveBeenCalledOnce();
    expect(session.protocol.handlers.has('morrow-pdf')).toBe(true);
    expect(contents.loadUrl).toMatch(/^morrow-pdf:\/\/document\/[A-Za-z0-9_-]{40,48}\/selected\.pdf$/);
    expect(contents.loadUrl).not.toContain(root);
    expect(view.visible).toBe(false);
    expect(opened.state).toMatchObject({ status: 'loading', name: 'selected.pdf' });
    expect(JSON.stringify(opened.state)).not.toContain(root);
    expect(session.webRequest.filter).toEqual({ urls: ['<all_urls>'] });
    const check = session.permissionCheck;
    expect(check?.(null, 'fileSystem', 'chrome-extension://pdf-viewer', { isMainFrame: false })).toBe(false);
    const granted: boolean[] = [];
    session.permissionRequest?.(contents, 'fileSystem', (value: boolean) => granted.push(value), {
      isDirectory: false,
    });
    expect(granted).toEqual([false]);

    const networkDecision: Array<{ cancel: boolean }> = [];
    session.webRequest.listener?.({ url: 'https://example.test/document.pdf' }, (decision) =>
      networkDecision.push(decision),
    );
    const capabilityDecision: Array<{ cancel: boolean }> = [];
    session.webRequest.listener?.({ url: contents.loadUrl! }, (decision) =>
      capabilityDecision.push(decision),
    );
    expect(networkDecision).toEqual([{ cancel: true }]);
    expect(capabilityDecision).toEqual([{ cancel: false }]);
    await waitForState(harness.manager, opened.viewerId, 'ready');
    harness.manager.clear();
  });

  it('places the native view synchronously in clamped DIP bounds and closes on stale owner', async () => {
    const root = makeRoot();
    makePdf(root);
    const harness = makeManager({ root });
    const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
    if (!opened.ok) throw new Error('Expected the selected PDF viewer to open.');
    const view = harness.views[0]!;
    harness.ownerContents.zoom = 2;

    expect(harness.manager.present(opened.viewerId, { x: 5, y: 10, width: 80, height: 60 }, true)).toBe(true);
    expect(harness.window.contentView.addChildView).toHaveBeenCalledOnce();
    expect(view.bounds).toEqual({ x: 10, y: 20, width: 160, height: 120 });
    expect(view.visible).toBe(true);
    expect(harness.manager.present(opened.viewerId, { x: -10, y: -5, width: 50, height: 30 }, true)).toBe(
      true,
    );
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 80, height: 50 });
    expect(harness.manager.present(opened.viewerId, { x: 500, y: 400, width: 100, height: 100 }, true)).toBe(
      false,
    );
    expect(view.visible).toBe(false);
    expect(
      harness.manager.present(opened.viewerId, { x: Number.NaN, y: 0, width: 20, height: 20 }, true),
    ).toBe(false);
    expect(view.visible).toBe(false);
    harness.window.dead = true;
    expect(harness.manager.present(opened.viewerId, { x: 0, y: 0, width: 20, height: 20 }, true)).toBe(false);
    expect(harness.manager.getState(opened.viewerId)).toBeNull();
    expect(harness.webContents[0]!.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  });

  it('uses native find request IDs and the Electron 44.7 start/continue sequence', async () => {
    const root = makeRoot();
    makePdf(root);
    const harness = makeManager({ root });
    const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
    if (!opened.ok) throw new Error('Expected the selected PDF viewer to open.');
    await waitForState(harness.manager, opened.viewerId, 'ready');
    const contents = harness.webContents[0]!;

    expect(harness.manager.find(opened.viewerId, 'needle')).toBe(true);
    expect(contents.findCalls[0]?.options).toEqual({ forward: true, findNext: true, matchCase: false });
    contents.emitter.emit(
      'found-in-page',
      {},
      { requestId: 1, matches: 2, activeMatchOrdinal: 1, finalUpdate: true },
    );
    expect(harness.manager.getState(opened.viewerId)).toMatchObject({ matches: 2, activeMatchOrdinal: 1 });
    expect(harness.manager.find(opened.viewerId, 'needle')).toBe(true);
    expect(contents.findCalls[1]?.options.findNext).toBe(false);
    expect(harness.manager.find(opened.viewerId, 'another')).toBe(true);
    expect(contents.findCalls[2]?.options.findNext).toBe(true);
    expect(JSON.stringify(harness.manager.getState(opened.viewerId))).not.toContain('needle');
    harness.manager.clear();
  });

  it('reports confirmed HTTP(S) links, blocks other navigation and cancels every download', async () => {
    const root = makeRoot();
    makePdf(root);
    const onExternalLink = vi.fn();
    const harness = makeManager({ root, onExternalLink });
    const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
    if (!opened.ok) throw new Error('Expected the selected PDF viewer to open.');
    const view = harness.views[0]!;
    const contents = harness.webContents[0]!;
    const session = harness.sessions[0]!;

    expect(contents.windowOpenHandler?.({ url: 'https://example.test/report' })).toEqual({ action: 'deny' });
    expect(onExternalLink).toHaveBeenCalledWith(opened.viewerId, 'https://example.test/report');
    contents.windowOpenHandler?.({ url: 'file:///private/document.pdf' });
    expect(onExternalLink).toHaveBeenCalledOnce();
    const preventDefault = vi.fn();
    contents.emitter.emit('will-navigate', { preventDefault }, 'https://example.test/same-window');
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onExternalLink).toHaveBeenCalledWith(opened.viewerId, 'https://example.test/same-window');

    const downloadPrevented = vi.fn();
    const canceled = vi.fn();
    session.emitter.emit(
      'will-download',
      { preventDefault: downloadPrevented },
      { cancel: canceled },
      view.webContents,
    );
    expect(downloadPrevented).toHaveBeenCalledOnce();
    expect(canceled).toHaveBeenCalledOnce();
    harness.manager.clear();
  });

  it('keeps password entry passive and transitions to ready after native decryption', async () => {
    const root = makeRoot();
    makePdf(root);
    const seen: PdfViewerState['status'][] = [];
    const snapshot: Snapshot = { status: 'password-required' };
    const harness = makeManager({
      root,
      snapshot,
      onState: (state) => seen.push(state.status),
      delay: async () => {
        snapshot.status = 'ready';
        snapshot.pageCount = 2;
      },
    });
    const openedPromise = harness.manager.open('vault-a', 'Documents/selected.pdf');
    const opened = await openedPromise;
    if (!opened.ok) throw new Error('Expected the protected PDF to open without reading its password.');
    await waitForState(harness.manager, opened.viewerId, 'ready');
    expect(seen).toContain('password-required');
    expect(harness.manager.getState(opened.viewerId)?.pageCount).toBe(2);
    harness.manager.clear();
  });

  it('tolerates a destroyed WebContents while revoking and disposing the viewer', async () => {
    const root = makeRoot();
    makePdf(root);
    const harness = makeManager({ root });
    const opened = await harness.manager.open('vault-a', 'Documents/selected.pdf');
    if (!opened.ok) throw new Error('Expected the selected PDF viewer to open.');
    const contents = harness.webContents[0]!;
    contents.dead = true;
    contents.stopFindInPage.mockImplementation(() => {
      throw new Error('WebContents already destroyed');
    });
    expect(() => contents.emitter.emit('destroyed')).not.toThrow();
    expect(harness.manager.getState(opened.viewerId)).toBeNull();
    expect(harness.sessions[0]!.protocol.unhandle).toHaveBeenCalledWith('morrow-pdf');
  });
});
