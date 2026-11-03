import { describe, expect, it } from 'vitest';
import { allowsAppFullscreenRequest } from './appFullscreenPermission.js';

const APP_ORIGIN = 'morrow://app';
function fixture(url = `${APP_ORIGIN}/index.html`) {
  const contents = { isDestroyed: () => false, mainFrame: { url } };
  const window = { isDestroyed: () => false, webContents: contents };
  const request = { permission: 'fullscreen', webContents: contents, details: { isMainFrame: true, requestingUrl: url } };
  return { contents, window, request };
}

describe('trusted application fullscreen permission', () => {
  it('allows ordinary fullscreen from the exact live application main frame', () => {
    const { window, request } = fixture();
    expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN)).toBe(true);
  });

  it('keeps automatic fullscreen and every unrelated permission denied', () => {
    const { window, request } = fixture();
    for (const permission of ['automatic-fullscreen', 'media', 'fileSystem', 'clipboard-read', 'notifications', 'unknown'])
      expect(allowsAppFullscreenRequest({ ...request, permission }, window, APP_ORIGIN)).toBe(false);
  });

  it('denies foreign contents, subframes and missing requesting URLs', () => {
    const { window, request } = fixture();
    expect(allowsAppFullscreenRequest({ ...request, webContents: fixture().contents }, window, APP_ORIGIN)).toBe(false);
    expect(allowsAppFullscreenRequest({ ...request, webContents: null }, window, APP_ORIGIN)).toBe(false);
    expect(allowsAppFullscreenRequest({ ...request, details: { ...request.details, isMainFrame: false } }, window, APP_ORIGIN)).toBe(false);
    expect(allowsAppFullscreenRequest({ ...request, details: { isMainFrame: true } }, window, APP_ORIGIN)).toBe(false);
  });

  it('denies destroyed windows or contents and frames lost during teardown', () => {
    const { window, request } = fixture();
    expect(allowsAppFullscreenRequest(request, null, APP_ORIGIN)).toBe(false);
    expect(allowsAppFullscreenRequest(request, { ...window, isDestroyed: () => true }, APP_ORIGIN)).toBe(false);
    window.webContents.isDestroyed = () => true;
    expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN)).toBe(false);
    const torn = fixture();
    Object.defineProperty(torn.contents, 'mainFrame', { get() { throw new Error('Frame destroyed'); } });
    expect(allowsAppFullscreenRequest(torn.request, torn.window, APP_ORIGIN)).toBe(false);
  });

  it('validates both the requester URL and the current main-frame URL', () => {
    for (const url of ['https://example.invalid/', 'morrow://app.evil/index.html', 'morrow://user:secret@app/', 'file:///synthetic.html']) {
      const { window, request } = fixture();
      expect(allowsAppFullscreenRequest({ ...request, details: { ...request.details, requestingUrl: url } }, window, APP_ORIGIN)).toBe(false);
      window.webContents.mainFrame.url = url;
      expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN)).toBe(false);
    }
  });

  it('allows only the exact configured development origin, never a URL prefix', () => {
    const devUrl = 'http://localhost:5173';
    const { window, request } = fixture(`${devUrl}/index.html`);
    expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN, devUrl)).toBe(true);
    expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN)).toBe(false);
    for (const url of ['http://localhost:51730/', 'http://localhost.evil:5173/', 'http://user@localhost:5173/']) {
      expect(allowsAppFullscreenRequest({ ...request, details: { ...request.details, requestingUrl: url } }, window, APP_ORIGIN, devUrl)).toBe(false);
      window.webContents.mainFrame.url = url;
      expect(allowsAppFullscreenRequest(request, window, APP_ORIGIN, devUrl)).toBe(false);
      window.webContents.mainFrame.url = `${devUrl}/index.html`;
    }
  });
});
