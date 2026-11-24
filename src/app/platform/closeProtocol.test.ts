import { describe, expect, it, vi } from 'vitest';
import type { ExitPreparationResult, ExitPreparationSession } from '../exitPreparation';
import {
  createCloseProtocolCoordinator,
  type CloseAckDisposition,
  type CloseCancelDisposition,
  type CloseDecision,
  type ClosePhase,
  type CloseProtocolTransport,
  type CloseSnapshot,
} from './closeProtocol';

type Listener = (generation: number) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}

function createHarness(
  options: {
    generation?: number;
    phase?: ClosePhase;
    getPreparer?: () => { prepare(): Promise<ExitPreparationResult<ExitPreparationSession>> } | null;
    listen?: (handler: Listener) => Promise<() => void>;
    snapshot?: (snapshot: CloseSnapshot) => Promise<CloseSnapshot>;
    acknowledge?: (
      generation: number,
      decision: CloseDecision,
      defaultAcknowledge: (generation: number, decision: CloseDecision) => Promise<CloseAckDisposition>,
    ) => Promise<CloseAckDisposition>;
    cancel?: (
      generation: number,
      defaultCancel: (generation: number) => Promise<CloseCancelDisposition>,
    ) => Promise<CloseCancelDisposition>;
  } = {},
) {
  let native: CloseSnapshot = {
    generation: options.generation ?? 0,
    phase: options.phase ?? 'idle',
  };
  let listener: Listener | null = null;
  let listening = false;
  let prepareCalls = 0;
  let leasesCreated = 0;
  let leasesReleased = 0;
  const acknowledgements: Array<{ generation: number; decision: CloseDecision }> = [];
  const cancellations: number[] = [];
  const failures: string[] = [];

  const defaultAcknowledge = async (
    generation: number,
    decision: CloseDecision,
  ): Promise<CloseAckDisposition> => {
    if (generation !== native.generation) return 'stale';
    if (native.phase === 'pending') {
      native = { ...native, phase: decision === 'allow' ? 'armed' : 'negative' };
      return decision === 'allow' ? 'armed' : 'denied';
    }
    if (native.phase === 'armed') return 'alreadyArmed';
    if (native.phase === 'negative') return 'alreadyDenied';
    if (native.phase === 'cancelled') return 'cancelled';
    if (native.phase === 'consumed') return 'consumed';
    return 'stale';
  };

  const defaultCancel = async (generation: number): Promise<CloseCancelDisposition> => {
    if (generation !== native.generation || native.phase === 'idle') return 'stale';
    if (native.phase === 'pending' || native.phase === 'armed') {
      native = { ...native, phase: 'cancelled' };
      return 'cancelled';
    }
    if (native.phase === 'negative') return 'negative';
    if (native.phase === 'cancelled') return 'cancelled';
    return 'consumed';
  };

  const defaultPreparer = {
    async prepare(): Promise<ExitPreparationResult<ExitPreparationSession>> {
      prepareCalls++;
      leasesCreated++;
      return {
        ok: true,
        lease: {
          session: null,
          release() {
            leasesReleased++;
          },
        },
      };
    },
  };

  const transport: CloseProtocolTransport = {
    async listen(handler) {
      listener = handler;
      listening = true;
      if (options.listen) return options.listen(handler);
      return () => {
        listening = false;
        listener = null;
      };
    },
    async snapshot() {
      if (!listening) throw new Error('query must follow effective subscription');
      const value = { ...native };
      return options.snapshot ? options.snapshot(value) : value;
    },
    async acknowledge(generation, decision) {
      acknowledgements.push({ generation, decision });
      return options.acknowledge
        ? options.acknowledge(generation, decision, defaultAcknowledge)
        : defaultAcknowledge(generation, decision);
    },
    async cancel(generation) {
      cancellations.push(generation);
      return options.cancel ? options.cancel(generation, defaultCancel) : defaultCancel(generation);
    },
  };

  const preparer = options.getPreparer ? options.getPreparer() : defaultPreparer;
  const coordinator = createCloseProtocolCoordinator({
    transport,
    getPreparer: () => preparer,
    reportFailure: (reason) => failures.push(reason),
  });

  function requestClose(): void {
    if (native.phase === 'idle' || native.phase === 'negative' || native.phase === 'cancelled') {
      native = { generation: native.generation + 1, phase: 'pending' };
      listener?.(native.generation);
    } else if (native.phase === 'pending') {
      listener?.(native.generation);
    } else if (native.phase === 'armed') {
      native = { ...native, phase: 'consumed' };
    }
  }

  return {
    coordinator,
    transport,
    requestClose,
    get native() {
      return { ...native };
    },
    setNative(snapshot: CloseSnapshot) {
      native = { ...snapshot };
    },
    get listener() {
      return listener;
    },
    get prepareCalls() {
      return prepareCalls;
    },
    get leasesCreated() {
      return leasesCreated;
    },
    get leasesReleased() {
      return leasesReleased;
    },
    acknowledgements,
    cancellations,
    failures,
  };
}

describe('native close protocol coordinator', () => {
  it('subscribes before querying and replays a native request that predates the listener', async () => {
    const harness = createHarness({ generation: 1, phase: 'pending' });
    await harness.coordinator.start();
    await settle();

    expect(harness.prepareCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
    expect(harness.native.phase).toBe('armed');
  });

  it('retries a rejected listener subscription and then replays the pending request', async () => {
    vi.useFakeTimers();
    let subscriptions = 0;
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      listen: async () => {
        subscriptions++;
        if (subscriptions === 1) throw new Error('event registration failed');
        return () => {};
      },
    });

    try {
      await harness.coordinator.start();
      expect(subscriptions).toBe(1);
      expect(harness.acknowledgements).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(subscriptions).toBe(2);
      expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
      expect(harness.native.phase).toBe('armed');
    } finally {
      harness.coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('retries a failed pending query without registering a second listener', async () => {
    vi.useFakeTimers();
    let subscriptions = 0;
    let snapshots = 0;
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      listen: async () => {
        subscriptions++;
        return () => {};
      },
      snapshot: async (snapshot) => {
        snapshots++;
        if (snapshots === 1) throw new Error('snapshot failed');
        return snapshot;
      },
    });

    try {
      await harness.coordinator.start();
      expect(subscriptions).toBe(1);
      expect(harness.acknowledgements).toEqual([]);

      await vi.advanceTimersByTimeAsync(1000);
      await settle();
      expect(subscriptions).toBe(1);
      expect(snapshots).toBe(2);
      expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
    } finally {
      harness.coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('coalesces an event delivered during subscription with the pending query replay', async () => {
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      listen: async (handler) => {
        handler(1);
        return () => {};
      },
    });
    await harness.coordinator.start();
    await settle();

    expect(harness.prepareCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
  });

  it('denies when the private preparer is missing instead of inferring a saved session', async () => {
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      getPreparer: () => null,
    });
    await harness.coordinator.start();
    await settle();

    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);
    expect(harness.native.phase).toBe('negative');
    expect(harness.failures).toContain('preparer-missing');
    expect(harness.leasesCreated).toBe(0);
  });

  it('ends a failed generation and allows a fresh request to retry', async () => {
    let preparations = 0;
    const harness = createHarness({
      getPreparer: () => ({
        async prepare() {
          preparations++;
          if (preparations === 1) return { ok: false, reason: 'flush-failed' };
          return {
            ok: true,
            lease: { session: null, release() {} },
          };
        },
      }),
    });
    harness.requestClose();
    await harness.coordinator.start();
    await settle();
    expect(harness.native).toEqual({ generation: 1, phase: 'negative' });

    harness.requestClose();
    await settle();
    expect(preparations).toBe(2);
    expect(harness.acknowledgements).toEqual([
      { generation: 1, decision: 'deny' },
      { generation: 2, decision: 'allow' },
    ]);
    expect(harness.native).toEqual({ generation: 2, phase: 'armed' });
  });

  it('does not treat a slow preparation as approval after elapsed time', async () => {
    vi.useFakeTimers();
    const preparation = deferred<ExitPreparationResult<ExitPreparationSession>>();
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      getPreparer: () => ({ prepare: () => preparation.promise }),
    });
    try {
      await harness.coordinator.start();
      await vi.advanceTimersByTimeAsync(6000);
      await settle();

      expect(harness.acknowledgements).toEqual([]);
      expect(harness.native.phase).toBe('pending');

      preparation.resolve({ ok: false, reason: 'flush-failed' });
      await settle();
      expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);
      expect(harness.native.phase).toBe('negative');
    } finally {
      harness.coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps a healthy lease through Armed and Consumed and ignores a delayed duplicate event', async () => {
    const harness = createHarness({ generation: 1, phase: 'pending' });
    await harness.coordinator.start();
    await settle();
    harness.listener?.(1);
    await settle();

    expect(harness.cancellations).toEqual([]);
    expect(harness.leasesReleased).toBe(0);
    harness.requestClose();
    expect(harness.native.phase).toBe('consumed');
    harness.listener?.(1);
    await settle();
    expect(harness.cancellations).toEqual([]);
    expect(harness.leasesReleased).toBe(0);
  });

  it('keeps the lease when an ACK transport error is followed by consumed', async () => {
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      acknowledge: async (generation, decision) => {
        if (decision === 'allow') {
          harness.setNative({ generation, phase: 'consumed' });
          throw new Error('ACK reply was lost after close consumption');
        }
        return 'consumed';
      },
    });
    await harness.coordinator.start();
    await settle();

    expect(harness.cancellations).toEqual([1]);
    expect(harness.native.phase).toBe('consumed');
    expect(harness.leasesReleased).toBe(0);
    expect(harness.failures).toContain('close-not-confirmed');
  });

  it('retains an uncertain lease when cancellation and query are ambiguous, then recovers on duplicate event', async () => {
    let snapshots = 0;
    let cancellations = 0;
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      acknowledge: async (_generation, decision, defaultAcknowledge) => {
        if (decision === 'allow') throw new Error('ACK outcome unknown');
        return defaultAcknowledge(_generation, decision);
      },
      cancel: async (_generation, defaultCancel) => {
        cancellations++;
        if (cancellations === 1) throw new Error('cancel response unknown');
        return defaultCancel(_generation);
      },
      snapshot: async (snapshot) => {
        snapshots++;
        if (snapshots === 2) throw new Error('query response unknown');
        return snapshot;
      },
    });
    await harness.coordinator.start();
    await settle();
    expect(harness.leasesReleased).toBe(0);

    harness.listener?.(1);
    await settle();
    expect(harness.cancellations).toEqual([1, 1]);
    expect(harness.native.phase).toBe('cancelled');
    expect(harness.leasesReleased).toBe(1);
  });

  it('releases an older lease after cancellation is superseded by a newer non-consumed request', async () => {
    const harness = createHarness({
      generation: 1,
      phase: 'pending',
      acknowledge: async (generation, decision, defaultAcknowledge) => {
        if (generation === 1 && decision === 'allow') throw new Error('ACK reply lost');
        return defaultAcknowledge(generation, decision);
      },
      cancel: async (generation, defaultCancel) => {
        if (generation === 1) {
          harness.setNative({ generation: 1, phase: 'cancelled' });
          harness.requestClose();
          return 'stale';
        }
        return defaultCancel(generation);
      },
    });
    await harness.coordinator.start();
    await settle();

    expect(harness.native).toEqual({ generation: 2, phase: 'armed' });
    expect(harness.leasesCreated).toBe(2);
    expect(harness.leasesReleased).toBe(1);
  });
});
