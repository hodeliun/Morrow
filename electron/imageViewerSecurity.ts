export interface ImageResourceOwner {
  readonly webContentsId: number;
  readonly frame: object;
  readonly vaultId: string;
}

export function isCurrentImageResourceOwner(
  owner: ImageResourceOwner | null,
  currentWebContentsId: number | null,
  currentMainFrame: object | null,
  currentFrameUrl: string | null,
  isTrustedUrl: (url: string) => boolean,
): boolean {
  return Boolean(
    owner &&
    currentWebContentsId !== null &&
    currentMainFrame &&
    currentFrameUrl &&
    owner.webContentsId === currentWebContentsId &&
    owner.frame === currentMainFrame &&
    isTrustedUrl(currentFrameUrl),
  );
}

export function shouldClearImageResourcesForNavigation(
  isMainFrame: boolean,
  isSameDocument: boolean,
): boolean {
  return isMainFrame && !isSameDocument;
}

export interface ImageResourceOwnerStore {
  claim(token: string, owner: ImageResourceOwner): boolean;
  get(token: string): ImageResourceOwner | null;
  owns(token: string, webContentsId: number, frame: object): boolean;
  release(token: string, webContentsId: number, frame: object): boolean;
  clear(): void;
}

export function createImageResourceOwnerStore(): ImageResourceOwnerStore {
  const owners = new Map<string, ImageResourceOwner>();
  return {
    claim(token, owner) {
      if (!token || !Number.isSafeInteger(owner.webContentsId) || !owner.vaultId || owners.has(token))
        return false;
      owners.set(token, owner);
      return true;
    },
    get(token) {
      return owners.get(token) ?? null;
    },
    owns(token, webContentsId, frame) {
      const owner = owners.get(token);
      return owner?.webContentsId === webContentsId && owner.frame === frame;
    },
    release(token, webContentsId, frame) {
      if (!this.owns(token, webContentsId, frame)) return false;
      return owners.delete(token);
    },
    clear() {
      owners.clear();
    },
  };
}

export function isTrustedImageViewerFrame(
  sender: object,
  senderFrame: object | null,
  mainWebContents: object | null,
  mainFrame: object | null,
  frameUrl: string,
  isAppUrl: (url: string) => boolean,
): boolean {
  return Boolean(
    mainWebContents &&
    mainFrame &&
    senderFrame &&
    sender === mainWebContents &&
    senderFrame === mainFrame &&
    isAppUrl(frameUrl),
  );
}

export function isTrustedImageResourceInitiator(
  initiatorOrigin: string | undefined,
  appOrigin: string,
  devUrl?: string | null,
): boolean {
  if (initiatorOrigin === undefined) return true;
  try {
    const request = new URL(initiatorOrigin);
    if (request.username || request.password) return false;
    const app = new URL(appOrigin);
    if (
      request.protocol === app.protocol &&
      request.hostname === app.hostname &&
      request.port === app.port &&
      request.username === '' &&
      request.password === ''
    )
      return true;
    if (!devUrl) return false;
    const dev = new URL(devUrl);
    return (
      (request.protocol === 'http:' || request.protocol === 'https:') &&
      request.protocol === dev.protocol &&
      request.hostname === dev.hostname &&
      request.port === dev.port
    );
  } catch {
    return false;
  }
}

export function isTrustedImageViewerAppUrl(value: string, appUrl: string, devUrl?: string | null): boolean {
  try {
    const candidate = new URL(value);
    if (candidate.username || candidate.password) return false;

    const app = new URL(appUrl);
    if (
      candidate.protocol === app.protocol &&
      candidate.hostname === app.hostname &&
      candidate.port === app.port
    )
      return true;

    if (!devUrl) return false;
    const dev = new URL(devUrl);
    return (
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      candidate.protocol === dev.protocol &&
      candidate.hostname === dev.hostname &&
      candidate.port === dev.port
    );
  } catch {
    return false;
  }
}
