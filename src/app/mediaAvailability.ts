import type { DesktopMediaAvailabilityNotice } from './platform/desktop';

export function isCurrentMediaUnavailableNotice(
  currentToken: string | null,
  disposed: boolean,
  active: boolean,
  notice: DesktopMediaAvailabilityNotice,
): boolean {
  return (
    !disposed &&
    active &&
    currentToken !== null &&
    notice.code === 'file-unavailable' &&
    notice.token === currentToken
  );
}

export interface MediaResourceTokens {
  resourceToken: string | null;
  availabilityToken: string | null;
}

export function retireFailedMediaResource(
  tokens: MediaResourceTokens,
  failedToken: string,
): { tokens: MediaResourceTokens; releaseToken: string | null } {
  if (tokens.resourceToken !== failedToken) return { tokens, releaseToken: null };
  return {
    tokens: {
      resourceToken: null,
      availabilityToken: tokens.availabilityToken === failedToken ? failedToken : null,
    },
    releaseToken: failedToken,
  };
}

export type MediaFailureDisplay = 'decode-error' | 'file-unavailable' | null;

export function resolveMediaAvailabilityNotice(
  currentDisplay: MediaFailureDisplay,
  availabilityToken: string | null,
  disposed: boolean,
  active: boolean,
  notice: DesktopMediaAvailabilityNotice | null,
): { accepted: boolean; display: MediaFailureDisplay } {
  if (!notice || !isCurrentMediaUnavailableNotice(availabilityToken, disposed, active, notice))
    return { accepted: false, display: currentDisplay };
  return { accepted: true, display: 'file-unavailable' };
}
