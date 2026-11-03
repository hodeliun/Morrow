import type { ImageResourceOwner, ImageResourceOwnerStore } from './imageViewerSecurity.js';

export interface MediaResourceAvailabilityMessage {
  readonly token: string;
  readonly code: 'file-unavailable';
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,48}$/;

export function parseMediaResourceAvailability(value: unknown): MediaResourceAvailabilityMessage | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('token' in value) ||
    typeof value.token !== 'string' ||
    !TOKEN_PATTERN.test(value.token) ||
    !('code' in value) ||
    value.code !== 'file-unavailable'
  )
    return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('token') || !keys.includes('code')) return null;
  return { token: value.token, code: value.code };
}

export function notifyMediaResourceUnavailable(
  token: string,
  owners: Pick<ImageResourceOwnerStore, 'get' | 'release'>,
  isCurrentOwner: (owner: ImageResourceOwner) => boolean,
  send: (message: MediaResourceAvailabilityMessage) => void,
): void {
  const owner = owners.get(token);
  if (!owner) return;
  try {
    if (isCurrentOwner(owner)) send({ token, code: 'file-unavailable' });
  } finally {
    owners.release(token, owner.webContentsId, owner.frame);
  }
}
