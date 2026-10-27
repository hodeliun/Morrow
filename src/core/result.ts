// explicit success or failure for operations the user should hear about
export type ResultFailureReason = {
  kind: 'linkedViewsBlockingTrash';
  hostPageIds: string[];
  referenceCount: number;
};

export type ResultFailure = { ok: false; error: string; reason?: ResultFailureReason };

export type Result<T> = { ok: true; value: T } | ResultFailure;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: string, reason?: ResultFailureReason): Result<T> {
  return reason ? { ok: false, error, reason } : { ok: false, error };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
