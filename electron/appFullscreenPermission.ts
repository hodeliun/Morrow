import { isTrustedImageViewerAppUrl } from './imageViewerSecurity.js';

interface FullscreenContents {
  isDestroyed(): boolean;
  readonly mainFrame: { readonly url: string };
}

interface FullscreenWindow {
  isDestroyed(): boolean;
  readonly webContents: FullscreenContents;
}

interface FullscreenRequest {
  permission: string;
  webContents: FullscreenContents | null;
  details: { isMainFrame?: unknown; requestingUrl?: unknown };
}

/** Permit ordinary HTML fullscreen only for the live trusted application's main frame. */
export function allowsAppFullscreenRequest(
  request: FullscreenRequest,
  window: FullscreenWindow | null,
  appOrigin: string,
  devUrl?: string | null,
): boolean {
  if (request.permission !== 'fullscreen' || request.details.isMainFrame !== true ||
      typeof request.details.requestingUrl !== 'string' || !window || !request.webContents)
    return false;
  try {
    return !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      request.webContents === window.webContents &&
      !request.webContents.isDestroyed() &&
      isTrustedImageViewerAppUrl(request.details.requestingUrl, appOrigin, devUrl) &&
      isTrustedImageViewerAppUrl(window.webContents.mainFrame.url, appOrigin, devUrl);
  } catch {
    // A frame can disappear during renderer teardown; that never grants a permission.
    return false;
  }
}
