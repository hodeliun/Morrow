import { describe, expect, it, vi } from 'vitest';
import {
  createExternalOpenErrorEnvelope,
  dispatchExternalOpenError,
  EXTERNAL_OPEN_ERROR_CHANNEL,
  sendExternalOpenError,
} from './externalOpenErrors.js';

function makeTarget({
  destroyed = false,
  url = 'morrow://app/index.html',
}: { destroyed?: boolean; url?: string } = {}) {
  return {
    isDestroyed: () => destroyed,
    getURL: () => url,
    send: vi.fn(),
  };
}

describe('external open error bridge payload', () => {
  it('sends only a safe browser error to the live trusted app renderer', () => {
    const target = makeTarget();
    const sent = sendExternalOpenError(
      target,
      (url) => url.startsWith('morrow://app/'),
      'https://example.test/a',
      'application-missing',
      true,
    );

    expect(sent).toBe(true);
    expect(target.send).toHaveBeenCalledExactlyOnceWith(EXTERNAL_OPEN_ERROR_CHANNEL, {
      url: 'https://example.test/a',
      code: 'application-missing',
      canChooseBrowser: true,
    });
  });

  it.each([
    [{ destroyed: true }, false],
    [{ url: 'https://remote.test/' }, false],
  ] as const)('does not send to a destroyed or non-app target: %j', (targetOptions, trusted) => {
    const target = makeTarget(targetOptions);
    const sent = sendExternalOpenError(
      target,
      () => trusted,
      'https://example.test/',
      'application-missing',
      true,
    );

    expect(sent).toBe(false);
    expect(target.send).not.toHaveBeenCalled();
  });

  it.each([
    ['https://user:secret@example.test/', 'invalid-url'],
    ['file:///C:/secret.txt', 'invalid-url'],
    ['https://example.test/\nheader', 'invalid-url'],
    ['https:example.test', 'invalid-url'],
  ])('does not expose an unsafe retry URL', (url, code) => {
    const envelope = createExternalOpenErrorEnvelope(url, code, true);
    expect(envelope).toEqual({ url: null, code, canChooseBrowser: false });
  });

  it('delivers a supported existing error code unchanged for localized presentation', () => {
    const listener = vi.fn();

    expect(
      dispatchExternalOpenError(
        { url: 'https://example.test/', code: 'application-missing', canChooseBrowser: false },
        listener,
      ),
    ).toBe(true);
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      url: 'https://example.test/',
      code: 'application-missing',
      canChooseBrowser: false,
    });
  });

  it.each([
    [{ url: 'file:///secret', code: 'application-missing', canChooseBrowser: true }],
    [{ url: 'https://user:pw@example.test/', code: 'application-missing', canChooseBrowser: true }],
    [{ url: 'https://example.test/', code: 'unknown-error', canChooseBrowser: true }],
    [{ url: 'https://example.test/', code: 'invalid-url', canChooseBrowser: true }],
    [{ url: 'https://example.test/', code: 'application-missing', canChooseBrowser: 'yes' }],
    [{ url: null, code: 'application-missing', canChooseBrowser: true }],
    [{ url: 'https://example.test/', code: 'application-missing', canChooseBrowser: true, extra: true }],
    [{ code: 'application-missing', canChooseBrowser: true }],
    [null],
    [['https://example.test/']],
  ])('rejects an invalid envelope without delivering it: %j', (payload) => {
    const listener = vi.fn();

    expect(dispatchExternalOpenError(payload, listener)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
