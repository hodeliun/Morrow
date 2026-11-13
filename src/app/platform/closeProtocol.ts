import type {
  ExitPreparationFailureReason,
  ExitPreparationLease,
  ExitPreparationResult,
  ExitPreparationSession,
  ExitPreparer,
} from '../exitPreparation';

export type ClosePhase = 'idle' | 'pending' | 'armed' | 'negative' | 'cancelled' | 'consumed';
export type CloseDecision = 'allow' | 'deny';
export type CloseAckDisposition =
  'armed' | 'denied' | 'alreadyArmed' | 'alreadyDenied' | 'cancelled' | 'consumed' | 'stale';
export type CloseCancelDisposition = 'cancelled' | 'negative' | 'consumed' | 'stale';
export type CloseProtocolFailure =
  | 'preparer-missing'
  | 'preparation-threw'
  | 'close-not-confirmed'
  | 'close-state-unavailable'
  | ExitPreparationFailureReason;

export interface CloseSnapshot {
  generation: number;
  phase: ClosePhase;
}

export interface CloseProtocolTransport {
  listen(handler: (generation: number) => void): Promise<() => void>;
  snapshot(): Promise<CloseSnapshot>;
  acknowledge(generation: number, decision: CloseDecision): Promise<CloseAckDisposition>;
  cancel(generation: number): Promise<CloseCancelDisposition>;
}

export interface CloseProtocolDependencies {
  transport: CloseProtocolTransport;
  getPreparer(): ExitPreparer<ExitPreparationSession> | null;
  reportFailure(reason: CloseProtocolFailure): void;
}

const LISTENER_RETRY_MS = 1000;

type Lease = ExitPreparationLease<ExitPreparationSession>;

type RequestRecord =
  | { kind: 'processing'; promise: Promise<void> }
  | { kind: 'settled' }
  | { kind: 'retry-denial'; reason: CloseProtocolFailure; checking: Promise<void> | null }
  | { kind: 'uncertain'; lease: Lease; checking: Promise<void> | null }
  | { kind: 'held'; lease: Lease; checking: Promise<void> | null };

function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isProvenInactive(snapshot: CloseSnapshot, generation: number): boolean {
  if (snapshot.generation === generation)
    return snapshot.phase === 'negative' || snapshot.phase === 'cancelled';
  return snapshot.generation > generation && snapshot.phase !== 'consumed';
}

/** Coordinates the native request with the prepared lease. It never turns elapsed time into approval. */
export function createCloseProtocolCoordinator(dependencies: CloseProtocolDependencies) {
  const requests = new Map<number, RequestRecord>();
  const reported = new Set<number>();
  let highestGeneration = 0;
  let startPromise: Promise<void> | null = null;
  let stopListening: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let lifecycle = 0;

  function report(generation: number, reason: CloseProtocolFailure): void {
    if (reported.has(generation)) return;
    reported.add(generation);
    try {
      dependencies.reportFailure(reason);
    } catch {
      // Reporting must not change the close decision or strand protocol cleanup.
    }
  }

  function scheduleRetry(attempt: number, retry: () => void): void {
    if (retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (attempt === lifecycle) retry();
    }, LISTENER_RETRY_MS);
  }

  function finishLease(generation: number, record: RequestRecord, lease: Lease): void {
    try {
      lease.release();
    } catch {
      // The preparer lease owns its own idempotent cleanup.
    }
    if (requests.get(generation) === record) requests.set(generation, { kind: 'settled' });
  }

  async function querySnapshot(): Promise<CloseSnapshot | null> {
    try {
      const snapshot = await dependencies.transport.snapshot();
      if (!isGeneration(snapshot.generation) && snapshot.generation !== 0) return null;
      if (!['idle', 'pending', 'armed', 'negative', 'cancelled', 'consumed'].includes(snapshot.phase))
        return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  async function reconcileLease(
    generation: number,
    record: Extract<RequestRecord, { kind: 'uncertain' | 'held' }>,
  ): Promise<void> {
    let cancellation: CloseCancelDisposition | null = null;
    try {
      cancellation = await dependencies.transport.cancel(generation);
    } catch {
      // The query below decides whether the authorization is still live.
    }

    if (cancellation === 'consumed') {
      requests.set(generation, { kind: 'held', lease: record.lease, checking: null });
      return;
    }

    const snapshot = await querySnapshot();
    if (!snapshot) {
      report(generation, 'close-state-unavailable');
      return;
    }
    if (isProvenInactive(snapshot, generation)) {
      finishLease(generation, record, record.lease);
      return;
    }
    if (snapshot.generation === generation && snapshot.phase === 'consumed') {
      requests.set(generation, { kind: 'held', lease: record.lease, checking: null });
      return;
    }
    // Pending, armed, older, or otherwise ambiguous state keeps the lease. A later native request
    // or startup replay can query/cancel again without preparing a second lease for this generation.
    requests.set(generation, { kind: 'uncertain', lease: record.lease, checking: null });
  }

  async function queryHeldLease(
    generation: number,
    record: Extract<RequestRecord, { kind: 'held' }>,
  ): Promise<void> {
    const snapshot = await querySnapshot();
    if (!snapshot) {
      report(generation, 'close-state-unavailable');
      return;
    }
    if (isProvenInactive(snapshot, generation)) {
      finishLease(generation, record, record.lease);
      return;
    }
    // A healthy positive ACK stays held in Armed and Consumed. It is never cancelled by a duplicate event.
  }

  function retryReconciliation(
    generation: number,
    record: Extract<RequestRecord, { kind: 'uncertain' }>,
  ): Promise<void> {
    if (record.checking) return record.checking;
    const checking = reconcileLease(generation, record).finally(() => {
      if (record.checking === checking) record.checking = null;
    });
    record.checking = checking;
    return checking;
  }

  function queryHeld(generation: number, record: Extract<RequestRecord, { kind: 'held' }>): Promise<void> {
    if (record.checking) return record.checking;
    const checking = queryHeldLease(generation, record).finally(() => {
      if (record.checking === checking) record.checking = null;
    });
    record.checking = checking;
    return checking;
  }

  async function reconcileOlderLeases(generation: number): Promise<void> {
    for (const [olderGeneration, initial] of [...requests.entries()]) {
      if (olderGeneration >= generation) continue;
      if (initial.kind === 'processing') await initial.promise;
      const record = requests.get(olderGeneration);
      if (record?.kind === 'uncertain') await retryReconciliation(olderGeneration, record);
      else if (record?.kind === 'held') await queryHeld(olderGeneration, record);
    }
  }

  async function retryDenial(
    generation: number,
    record: Extract<RequestRecord, { kind: 'retry-denial' }>,
  ): Promise<void> {
    if (record.checking) return record.checking;
    const checking = (async () => {
      let disposition: CloseAckDisposition | null = null;
      try {
        disposition = await dependencies.transport.acknowledge(generation, 'deny');
      } catch {
        // An IPC rejection cannot mean the request was positively confirmed.
      }

      if (
        disposition === 'denied' ||
        disposition === 'alreadyDenied' ||
        disposition === 'cancelled' ||
        disposition === 'consumed'
      ) {
        if (requests.get(generation) === record) requests.set(generation, { kind: 'settled' });
        return;
      }

      if (disposition === 'armed' || disposition === 'alreadyArmed') {
        try {
          await dependencies.transport.cancel(generation);
        } catch {
          // A query is still required to learn whether the positive authorization was consumed.
        }
      }

      const snapshot = await querySnapshot();
      if (snapshot && isProvenInactive(snapshot, generation)) {
        if (requests.get(generation) === record) requests.set(generation, { kind: 'settled' });
        return;
      }
      // A duplicate event for this generation retries the negative ACK; it can never become allow.
    })().finally(() => {
      if (record.checking === checking) record.checking = null;
    });
    record.checking = checking;
    return checking;
  }

  async function denyRequest(generation: number, reason: CloseProtocolFailure): Promise<void> {
    report(generation, reason);
    const record: Extract<RequestRecord, { kind: 'retry-denial' }> = {
      kind: 'retry-denial',
      reason,
      checking: null,
    };
    requests.set(generation, record);
    await retryDenial(generation, record);
  }

  async function prepareRequest(generation: number): Promise<void> {
    let preparer: ExitPreparer<ExitPreparationSession> | null;
    try {
      preparer = dependencies.getPreparer();
    } catch {
      preparer = null;
    }
    if (!preparer) {
      await denyRequest(generation, 'preparer-missing');
      return;
    }

    let result: ExitPreparationResult<ExitPreparationSession>;
    try {
      result = await preparer.prepare();
    } catch {
      await denyRequest(generation, 'preparation-threw');
      return;
    }
    if (!result.ok) {
      await denyRequest(generation, result.reason);
      return;
    }

    const lease = result.lease;
    let disposition: CloseAckDisposition;
    try {
      disposition = await dependencies.transport.acknowledge(generation, 'allow');
    } catch {
      const record: Extract<RequestRecord, { kind: 'uncertain' }> = {
        kind: 'uncertain',
        lease,
        checking: null,
      };
      requests.set(generation, record);
      report(generation, 'close-not-confirmed');
      await retryReconciliation(generation, record);
      return;
    }

    if (disposition === 'armed' || disposition === 'alreadyArmed' || disposition === 'consumed') {
      // Even Consumed does not release the lease: the close is irreversible and the window is exiting.
      requests.set(generation, { kind: 'held', lease, checking: null });
      return;
    }
    if (disposition === 'denied' || disposition === 'alreadyDenied' || disposition === 'cancelled') {
      try {
        lease.release();
      } catch {
        // The window is not authorized to close; cleanup remains owned by the preparer.
      }
      report(generation, 'close-not-confirmed');
      requests.set(generation, { kind: 'settled' });
      return;
    }

    const record: Extract<RequestRecord, { kind: 'uncertain' }> = {
      kind: 'uncertain',
      lease,
      checking: null,
    };
    requests.set(generation, record);
    report(generation, 'close-not-confirmed');
    await retryReconciliation(generation, record);
  }

  function receiveRequest(generation: number): void {
    if (!isGeneration(generation)) return;
    const existing = requests.get(generation);
    if (existing) {
      if (existing.kind === 'uncertain') void retryReconciliation(generation, existing);
      else if (existing.kind === 'retry-denial') void retryDenial(generation, existing);
      return;
    }
    if (generation < highestGeneration) return;
    highestGeneration = Math.max(highestGeneration, generation);

    const promise = Promise.resolve()
      .then(async () => {
        await reconcileOlderLeases(generation);
        await prepareRequest(generation);
      })
      .catch(() => {
        report(generation, 'close-state-unavailable');
      })
      .then(() => {
        if (requests.get(generation) === record) requests.set(generation, { kind: 'settled' });
      });
    const record: Extract<RequestRecord, { kind: 'processing' }> = { kind: 'processing', promise };
    requests.set(generation, record);
  }

  async function replayPending(attempt: number): Promise<void> {
    if (attempt !== lifecycle || !stopListening) return;
    const snapshot = await querySnapshot();
    if (attempt !== lifecycle) return;
    if (!snapshot) {
      report(0, 'close-state-unavailable');
      scheduleRetry(attempt, () => {
        void replayPending(attempt);
      });
      return;
    }
    if (snapshot.phase === 'pending') receiveRequest(snapshot.generation);
  }

  async function start(): Promise<void> {
    if (startPromise) return startPromise;
    const attempt = lifecycle;
    startPromise = Promise.resolve().then(async () => {
      let unlisten: () => void;
      try {
        unlisten = await dependencies.transport.listen(receiveRequest);
      } catch {
        if (attempt !== lifecycle) return;
        startPromise = null;
        report(0, 'close-state-unavailable');
        scheduleRetry(attempt, () => {
          void start().catch(() => {});
        });
        return;
      }
      if (attempt !== lifecycle) {
        unlisten();
        return;
      }
      stopListening = unlisten;
      await replayPending(attempt);
    });
    return startPromise;
  }

  function dispose(): void {
    lifecycle++;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    stopListening?.();
    stopListening = null;
    startPromise = null;
  }

  return { start, dispose };
}
