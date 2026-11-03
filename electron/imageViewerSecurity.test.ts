import { describe, expect, it } from 'vitest';
import {
  createImageResourceOwnerStore,
  isCurrentImageResourceOwner,
  isTrustedImageResourceInitiator,
  isTrustedImageViewerAppUrl,
  isTrustedImageViewerFrame,
  shouldClearImageResourcesForNavigation,
} from './imageViewerSecurity.js';

describe('image viewer capability ownership', () => {
  it('matches the exact app origin instead of a URL prefix', () => {
    expect(isTrustedImageViewerAppUrl('morrow://app/index.html', 'morrow://app')).toBe(true);
    expect(isTrustedImageViewerAppUrl('morrow://app.evil/index.html', 'morrow://app')).toBe(false);
    expect(isTrustedImageViewerAppUrl('morrow://user@app/index.html', 'morrow://app')).toBe(false);
    expect(
      isTrustedImageViewerAppUrl(
        'http://127.0.0.1:5173/index.html',
        'morrow://app',
        'http://127.0.0.1:5173/',
      ),
    ).toBe(true);
    expect(
      isTrustedImageViewerAppUrl(
        'http://127.0.0.1:5173.evil.test/index.html',
        'morrow://app',
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false);
    expect(
      isTrustedImageViewerAppUrl(
        'http://127.0.0.1:5174/index.html',
        'morrow://app',
        'http://127.0.0.1:5173/',
      ),
    ).toBe(false);
  });

  it('binds independent leases to the exact contents id and main frame', () => {
    const owners = createImageResourceOwnerStore();
    const frameA = {};
    const frameB = {};
    expect(owners.claim('token-a', { webContentsId: 10, frame: frameA, vaultId: 'vault-a' })).toBe(true);
    expect(owners.claim('token-b', { webContentsId: 10, frame: frameA, vaultId: 'vault-a' })).toBe(true);
    expect(owners.claim('token-c', { webContentsId: 11, frame: frameB, vaultId: 'vault-a' })).toBe(true);
    expect(owners.release('token-a', 11, frameB)).toBe(false);
    expect(owners.release('token-a', 10, frameB)).toBe(false);
    expect(owners.release('token-a', 10, frameA)).toBe(true);
    expect(owners.get('token-a')).toBeNull();
    expect(owners.owns('token-b', 10, frameA)).toBe(true);
    expect(owners.owns('token-c', 11, frameB)).toBe(true);
  });

  it('clears every owner on vault lifecycle changes', () => {
    const owners = createImageResourceOwnerStore();
    owners.claim('token-a', { webContentsId: 10, frame: {}, vaultId: 'vault-a' });
    owners.claim('token-b', { webContentsId: 11, frame: {}, vaultId: 'vault-b' });
    owners.clear();
    expect(owners.get('token-a')).toBeNull();
    expect(owners.get('token-b')).toBeNull();
  });

  it('requires the owner to match the current live window frame and trusted URL', () => {
    const owners = createImageResourceOwnerStore();
    const oldFrame = {};
    const newFrame = {};
    const owner = { webContentsId: 10, frame: oldFrame, vaultId: 'vault-a' };
    owners.claim('token-a', owner);
    const trustedUrl = (url: string) => isTrustedImageViewerAppUrl(url, 'morrow://app');

    expect(
      isCurrentImageResourceOwner(owners.get('token-a'), 10, oldFrame, 'morrow://app/index.html', trustedUrl),
    ).toBe(true);
    expect(
      isCurrentImageResourceOwner(owners.get('token-a'), 10, newFrame, 'morrow://app/index.html', trustedUrl),
    ).toBe(false);
    expect(isCurrentImageResourceOwner(owners.get('token-a'), null, null, null, trustedUrl)).toBe(false);
    expect(
      isCurrentImageResourceOwner(owners.get('token-a'), 10, oldFrame, 'morrow://app.evil/', trustedUrl),
    ).toBe(false);
  });

  it('clears only for full main-frame navigations, not hash or child-frame navigation', () => {
    expect(shouldClearImageResourcesForNavigation(true, false)).toBe(true);
    expect(shouldClearImageResourcesForNavigation(true, true)).toBe(false);
    expect(shouldClearImageResourcesForNavigation(false, false)).toBe(false);
    expect(shouldClearImageResourcesForNavigation(false, true)).toBe(false);
  });

  it('requires the exact main webContents and main frame as well as an app URL', () => {
    const mainContents = {};
    const mainFrame = {};
    const otherContents = {};
    const otherFrame = {};
    const isAppUrl = (url: string) =>
      url.startsWith('morrow://app/') || url.startsWith('http://127.0.0.1:5173/');

    expect(
      isTrustedImageViewerFrame(
        mainContents,
        mainFrame,
        mainContents,
        mainFrame,
        'morrow://app/index.html',
        isAppUrl,
      ),
    ).toBe(true);
    expect(
      isTrustedImageViewerFrame(
        otherContents,
        otherFrame,
        mainContents,
        mainFrame,
        'morrow://app/index.html',
        isAppUrl,
      ),
    ).toBe(false);
    expect(
      isTrustedImageViewerFrame(
        mainContents,
        otherFrame,
        mainContents,
        mainFrame,
        'morrow://app/index.html',
        isAppUrl,
      ),
    ).toBe(false);
    expect(
      isTrustedImageViewerFrame(
        mainContents,
        mainFrame,
        mainContents,
        mainFrame,
        'https://example.test/',
        isAppUrl,
      ),
    ).toBe(false);
  });

  it('accepts absent image initiator metadata but rejects a present foreign origin', () => {
    expect(isTrustedImageResourceInitiator(undefined, 'morrow://app')).toBe(true);
    expect(isTrustedImageResourceInitiator('morrow://app/', 'morrow://app')).toBe(true);
    expect(isTrustedImageResourceInitiator('morrow://app/notes', 'morrow://app')).toBe(true);
    expect(isTrustedImageResourceInitiator('morrow://app.evil/', 'morrow://app')).toBe(false);
    expect(isTrustedImageResourceInitiator('morrow://user@app/', 'morrow://app')).toBe(false);
    expect(isTrustedImageResourceInitiator('file:///C:/outside.png', 'morrow://app')).toBe(false);
    expect(isTrustedImageResourceInitiator('data:text/html,evil', 'morrow://app')).toBe(false);
    expect(
      isTrustedImageResourceInitiator('http://127.0.0.1:5173', 'morrow://app', 'http://127.0.0.1:5173/'),
    ).toBe(true);
    expect(
      isTrustedImageResourceInitiator('http://127.0.0.1:5174', 'morrow://app', 'http://127.0.0.1:5173/'),
    ).toBe(false);
    expect(isTrustedImageResourceInitiator('https://example.test', 'morrow://app')).toBe(false);
    expect(isTrustedImageResourceInitiator('null', 'morrow://app')).toBe(false);
  });
});
