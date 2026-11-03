import { describe, expect, it, vi } from 'vitest';
import { createImageResourceOwnerStore } from './imageViewerSecurity.js';
import { notifyMediaResourceUnavailable, parseMediaResourceAvailability } from './mediaAvailability.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

describe('media availability notifications', () => {
  it('routes only the opaque token to the current owner and releases that owner once', () => {
    const owners = createImageResourceOwnerStore();
    const owner = { webContentsId: 17, frame: {}, vaultId: 'synthetic-vault' };
    expect(owners.claim(TOKEN, owner)).toBe(true);
    const send = vi.fn();

    notifyMediaResourceUnavailable(TOKEN, owners, (candidate) => candidate === owner, send);
    notifyMediaResourceUnavailable(TOKEN, owners, () => true, send);

    expect(send).toHaveBeenCalledExactlyOnceWith({ token: TOKEN, code: 'file-unavailable' });
    expect(owners.get(TOKEN)).toBeNull();
  });

  it('does not send to a stale owner and still releases the failed capability owner', () => {
    const owners = createImageResourceOwnerStore();
    const owner = { webContentsId: 19, frame: {}, vaultId: 'synthetic-vault' };
    expect(owners.claim(TOKEN, owner)).toBe(true);
    const send = vi.fn();

    notifyMediaResourceUnavailable(TOKEN, owners, () => false, send);

    expect(send).not.toHaveBeenCalled();
    expect(owners.get(TOKEN)).toBeNull();
  });

  it('accepts only the token and the fixed unavailable code from IPC', () => {
    expect(parseMediaResourceAvailability({ token: TOKEN, code: 'file-unavailable' })).toEqual({
      token: TOKEN,
      code: 'file-unavailable',
    });
    for (const value of [
      { token: 'short', code: 'file-unavailable' },
      { token: TOKEN, code: 'decode-error' },
      { token: TOKEN, code: 'file-unavailable', path: 'private/absolute/path.wav' },
      null,
    ])
      expect(parseMediaResourceAvailability(value)).toBeNull();
  });
});
