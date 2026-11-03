import { describe, expect, it } from 'vitest';
import { resolveMediaAvailabilityNotice, retireFailedMediaResource } from './mediaAvailability';

const current = { token: 'active-capability-token', code: 'file-unavailable' as const };

describe('media availability UI decisions', () => {
  it('keeps a correlation token when network error 2 arrives before the unavailable notice', () => {
    const failed = retireFailedMediaResource(
      { resourceToken: current.token, availabilityToken: current.token },
      current.token,
    );

    expect(failed).toEqual({
      tokens: { resourceToken: null, availabilityToken: current.token },
      releaseToken: current.token,
    });
    expect(
      resolveMediaAvailabilityNotice('decode-error', failed.tokens.availabilityToken, false, true, current),
    ).toEqual({
      accepted: true,
      display: 'file-unavailable',
    });
  });

  it('keeps correlation if Chromium reports source-not-supported error 4 before the notice', () => {
    const failed = retireFailedMediaResource(
      { resourceToken: current.token, availabilityToken: current.token },
      current.token,
    );

    expect(failed.tokens.resourceToken).toBeNull();
    expect(failed.tokens.availabilityToken).toBe(current.token);
    expect(
      resolveMediaAvailabilityNotice('decode-error', failed.tokens.availabilityToken, false, true, current),
    ).toEqual({
      accepted: true,
      display: 'file-unavailable',
    });
  });

  it('keeps a valid-file decode error when no unavailable notice arrives', () => {
    const failed = retireFailedMediaResource(
      { resourceToken: current.token, availabilityToken: current.token },
      current.token,
    );

    expect(
      resolveMediaAvailabilityNotice('decode-error', failed.tokens.availabilityToken, false, true, null),
    ).toEqual({
      accepted: false,
      display: 'decode-error',
    });
  });

  it('ignores stale, unmounted, and inactive availability notices', () => {
    expect(
      resolveMediaAvailabilityNotice('decode-error', 'new-capability-token', false, true, current),
    ).toEqual({
      accepted: false,
      display: 'decode-error',
    });
    expect(resolveMediaAvailabilityNotice('decode-error', current.token, true, true, current)).toEqual({
      accepted: false,
      display: 'decode-error',
    });
    expect(resolveMediaAvailabilityNotice('decode-error', current.token, false, false, current)).toEqual({
      accepted: false,
      display: 'decode-error',
    });
  });

  it('rejects an old notice before effects after file-unavailable was already confirmed', () => {
    expect(resolveMediaAvailabilityNotice('file-unavailable', null, false, true, current)).toEqual({
      accepted: false,
      display: 'file-unavailable',
    });
  });

  it('does not let a failed old media element retire the new resource', () => {
    const next = { resourceToken: 'new-capability-token', availabilityToken: 'new-capability-token' };
    expect(retireFailedMediaResource(next, current.token)).toEqual({ tokens: next, releaseToken: null });
  });
});
