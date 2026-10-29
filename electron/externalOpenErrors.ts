export const EXTERNAL_OPEN_ERROR_CHANNEL = 'morrow:external-open-error';

export interface ExternalOpenErrorEnvelope {
  url: string | null;
  code: string;
  canChooseBrowser: boolean;
}

export interface ExternalOpenErrorTarget {
  isDestroyed(): boolean;
  getURL(): string;
  send(channel: string, payload: ExternalOpenErrorEnvelope): void;
}

const errorCodes = new Set([
  'application-invalid',
  'application-missing',
  'cancelled',
  'device-identity-unavailable',
  'device-mismatch',
  'invalid-request',
  'invalid-url',
  'launch-failed',
  'not-allowed',
  'open-failed',
]);

const browserRecoveryCodes = new Set([
  'application-invalid',
  'application-missing',
  'device-identity-unavailable',
  'device-mismatch',
  'launch-failed',
  'open-failed',
]);

function safeHttpUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8192 ||
    !/^https?:\/\//i.test(value) ||
    value !== value.trim() ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  )
    return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function createExternalOpenErrorEnvelope(
  urlValue: unknown,
  codeValue: unknown,
  canChooseBrowser: boolean,
): ExternalOpenErrorEnvelope {
  const code = typeof codeValue === 'string' && errorCodes.has(codeValue) ? codeValue : 'open-failed';
  const url = safeHttpUrl(urlValue);
  return {
    url,
    code,
    canChooseBrowser: url !== null && canChooseBrowser && browserRecoveryCodes.has(code),
  };
}

export function parseExternalOpenError(value: unknown): ExternalOpenErrorEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== 3 ||
    !keys.every((key) => typeof key === 'string' && ['url', 'code', 'canChooseBrowser'].includes(key)) ||
    typeof record.code !== 'string' ||
    !errorCodes.has(record.code) ||
    typeof record.canChooseBrowser !== 'boolean'
  )
    return null;

  let url: string | null = null;
  if (record.url !== null) {
    const safeUrl = safeHttpUrl(record.url);
    if (safeUrl === null || safeUrl !== record.url) return null;
    url = safeUrl;
  }
  if (record.canChooseBrowser && (url === null || !browserRecoveryCodes.has(record.code))) return null;

  return { url, code: record.code, canChooseBrowser: record.canChooseBrowser };
}

export function dispatchExternalOpenError(
  value: unknown,
  listener: (error: ExternalOpenErrorEnvelope) => void,
): boolean {
  const error = parseExternalOpenError(value);
  if (!error) return false;
  listener(error);
  return true;
}

export function sendExternalOpenError(
  target: ExternalOpenErrorTarget,
  isTrustedAppUrl: (url: string) => boolean,
  urlValue: unknown,
  codeValue: unknown,
  canChooseBrowser: boolean,
): boolean {
  try {
    if (target.isDestroyed() || !isTrustedAppUrl(target.getURL())) return false;
    target.send(
      EXTERNAL_OPEN_ERROR_CHANNEL,
      createExternalOpenErrorEnvelope(urlValue, codeValue, canChooseBrowser),
    );
    return true;
  } catch {
    return false;
  }
}
