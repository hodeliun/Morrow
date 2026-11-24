// @vitest-environment happy-dom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExitPreparationLease,
  ExitPreparationResult,
  ExitPreparationSession,
  ExitPreparer,
} from '../exitPreparation';
import { Toasts } from '../components/primitives';
import { t } from '../i18n';
import { toast, setUi } from '../ui';
import {
  createCloseProtocolCoordinator,
  type CloseAckDisposition,
  type CloseCancelDisposition,
  type CloseDecision,
  type CloseProtocolFailure,
  type CloseProtocolTransport,
  type CloseSnapshot,
} from './closeProtocol';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Listener = (generation: number) => void;
type Preparation = ExitPreparationResult<ExitPreparationSession>;
type MakeLease = () => ExitPreparationLease<ExitPreparationSession>;

interface HarnessOptions {
  initial?: CloseSnapshot;
  getPreparer?: () => ExitPreparer<ExitPreparationSession> | null;
  prepare?: (makeLease: MakeLease) => Promise<Preparation>;
  listen?: (handler: Listener, attempt: number) => Promise<() => void>;
  snapshot?: (snapshot: CloseSnapshot, attempt: number) => Promise<CloseSnapshot>;
  acknowledge?: (
    generation: number,
    decision: CloseDecision,
    nativeAcknowledge: (generation: number, decision: CloseDecision) => Promise<CloseAckDisposition>,
  ) => Promise<CloseAckDisposition>;
  cancel?: (
    generation: number,
    nativeCancel: (generation: number) => Promise<CloseCancelDisposition>,
  ) => Promise<CloseCancelDisposition>;
  reportFailure?: (reason: CloseProtocolFailure) => void;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 40; index++) await Promise.resolve();
}

const coordinators = new Set<ReturnType<typeof createCloseProtocolCoordinator>>();
const roots = new Set<Root>();

function createHarness(options: HarnessOptions = {}) {
  let native: CloseSnapshot = options.initial ?? { generation: 0, phase: 'idle' };
  let listener: Listener | null = null;
  let listening = false;
  let listenCalls = 0;
  let snapshotCalls = 0;
  let prepareCalls = 0;
  let leasesCreated = 0;
  let leasesReleased = 0;
  const order: string[] = [];
  const acknowledgements: Array<{ generation: number; decision: CloseDecision }> = [];
  const cancellations: number[] = [];
  const failures: CloseProtocolFailure[] = [];

  const makeLease: MakeLease = () => {
    leasesCreated++;
    return {
      session: null,
      release() {
        leasesReleased++;
      },
    };
  };

  const nativeAcknowledge = async (
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

  const nativeCancel = async (generation: number): Promise<CloseCancelDisposition> => {
    if (generation !== native.generation || native.phase === 'idle') return 'stale';
    if (native.phase === 'pending' || native.phase === 'armed') {
      native = { ...native, phase: 'cancelled' };
      return 'cancelled';
    }
    if (native.phase === 'negative') return 'negative';
    if (native.phase === 'cancelled') return 'cancelled';
    return 'consumed';
  };

  const defaultPreparer: ExitPreparer<ExitPreparationSession> = {
    async prepare(): Promise<Preparation> {
      prepareCalls++;
      return options.prepare ? options.prepare(makeLease) : { ok: true, lease: makeLease() };
    },
  };

  const transport: CloseProtocolTransport = {
    async listen(handler) {
      listenCalls++;
      order.push('listen:start');
      try {
        const unlisten = options.listen ? await options.listen(handler, listenCalls) : () => {};
        listener = handler;
        listening = true;
        order.push('listen:effective');
        return () => {
          unlisten();
          if (listener === handler) {
            listener = null;
            listening = false;
          }
        };
      } catch (error) {
        listener = null;
        listening = false;
        throw error;
      }
    },
    async snapshot() {
      snapshotCalls++;
      order.push('snapshot');
      if (!listening) throw new Error('The pending query ran before listen became effective.');
      const current = { ...native };
      return options.snapshot ? options.snapshot(current, snapshotCalls) : current;
    },
    async acknowledge(generation, decision) {
      acknowledgements.push({ generation, decision });
      return options.acknowledge
        ? options.acknowledge(generation, decision, nativeAcknowledge)
        : nativeAcknowledge(generation, decision);
    },
    async cancel(generation) {
      cancellations.push(generation);
      return options.cancel ? options.cancel(generation, nativeCancel) : nativeCancel(generation);
    },
  };

  const coordinator = createCloseProtocolCoordinator({
    transport,
    getPreparer: options.getPreparer ?? (() => defaultPreparer),
    reportFailure(reason) {
      failures.push(reason);
      options.reportFailure?.(reason);
    },
  });
  coordinators.add(coordinator);

  function deliver(generation: number): void {
    listener?.(generation);
  }

  function requestClose(): void {
    if (native.phase === 'idle' || native.phase === 'negative' || native.phase === 'cancelled') {
      native = { generation: native.generation + 1, phase: 'pending' };
      deliver(native.generation);
    } else if (native.phase === 'pending') {
      deliver(native.generation);
    } else if (native.phase === 'armed') {
      // The real native CloseRequested event consumes an armed authorization.
      native = { ...native, phase: 'consumed' };
    }
  }

  return {
    coordinator,
    requestClose,
    deliver,
    setNative(snapshot: CloseSnapshot) {
      native = { ...snapshot };
    },
    get native() {
      return { ...native };
    },
    get listenCalls() {
      return listenCalls;
    },
    get snapshotCalls() {
      return snapshotCalls;
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
    order,
    acknowledgements,
    cancellations,
    failures,
  };
}

afterEach(async () => {
  for (const coordinator of coordinators) coordinator.dispose();
  coordinators.clear();
  for (const root of roots) {
    await act(async () => root.unmount());
  }
  roots.clear();
  document.body.replaceChildren();
  setUi({ toasts: [] });
  vi.useRealTimers();
});

describe('independent native close protocol checks', () => {
  it('installs the listener before querying and replays a request that preceded startup', async () => {
    const harness = createHarness({ initial: { generation: 1, phase: 'pending' } });

    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.order.indexOf('listen:effective')).toBeLessThan(harness.order.indexOf('snapshot'));
    expect(harness.prepareCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
    expect(harness.native).toEqual({ generation: 1, phase: 'armed' });
  });

  it('coalesces a delivered event with the same request found by the startup query', async () => {
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      listen: async (handler) => {
        // Simulates the event arriving as soon as the native listener is installed, before query replay.
        handler(1);
        return () => {};
      },
    });

    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.prepareCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
  });

  it('denies when the preparer registry is missing and shows the failure toast beside Boot', async () => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.add(root);
    await act(async () => {
      root.render(
        createElement(
          Fragment,
          null,
          createElement('div', { 'data-testid': 'boot' }, 'Opening workspace'),
          createElement(Toasts),
        ),
      );
    });

    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      getPreparer: () => null,
      reportFailure: () => toast(t('topBar.saveFailed'), { tone: 'error' }),
    });
    await act(async () => {
      await harness.coordinator.start();
      await settleMicrotasks();
    });

    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);
    expect(harness.native.phase).toBe('negative');
    expect(harness.failures).toContain('preparer-missing');
    expect(harness.leasesCreated).toBe(0);
    expect(host.querySelector('[data-testid="boot"]')).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('topBar.saveFailed'));
    vi.clearAllTimers();
  });

  it('finalizes a failed generation, ignores its late duplicate, and retries under a new generation', async () => {
    let preparationCount = 0;
    const harness = createHarness({
      prepare: async (makeLease) => {
        preparationCount++;
        if (preparationCount === 1) return { ok: false, reason: 'flush-failed' };
        return { ok: true, lease: makeLease() };
      },
    });
    await harness.coordinator.start();

    harness.requestClose();
    await settleMicrotasks();
    expect(harness.native).toEqual({ generation: 1, phase: 'negative' });

    harness.deliver(1);
    await settleMicrotasks();
    expect(preparationCount).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);

    harness.requestClose();
    await settleMicrotasks();
    harness.deliver(1);
    await settleMicrotasks();

    expect(harness.native).toEqual({ generation: 2, phase: 'armed' });
    expect(preparationCount).toBe(2);
    expect(harness.acknowledgements).toEqual([
      { generation: 1, decision: 'deny' },
      { generation: 2, decision: 'allow' },
    ]);
    expect(harness.leasesReleased).toBe(0);
  });

  it('turns a rejected preparation into a final negative ACK and lets a new generation retry', async () => {
    let preparationCount = 0;
    const harness = createHarness({
      prepare: async (makeLease) => {
        preparationCount++;
        if (preparationCount === 1) throw new Error('Preparation rejected unexpectedly.');
        return { ok: true, lease: makeLease() };
      },
    });
    await harness.coordinator.start();

    harness.requestClose();
    await settleMicrotasks();
    expect(harness.native).toEqual({ generation: 1, phase: 'negative' });
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);
    expect(harness.failures).toContain('preparation-threw');
    expect(harness.leasesCreated).toBe(0);

    harness.requestClose();
    await settleMicrotasks();
    expect(harness.native).toEqual({ generation: 2, phase: 'armed' });
    expect(harness.acknowledgements).toEqual([
      { generation: 1, decision: 'deny' },
      { generation: 2, decision: 'allow' },
    ]);
    expect(harness.leasesReleased).toBe(0);
  });

  it('retries listener registration and pending reconciliation without authorizing on a timer', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      listen: async (_handler, attempt) => {
        if (attempt === 1) throw new Error('listener setup failed');
        return () => {};
      },
    });

    await harness.coordinator.start();
    await settleMicrotasks();
    expect(harness.listenCalls).toBe(1);
    expect(harness.snapshotCalls).toBe(0);
    expect(harness.acknowledgements).toEqual([]);

    await vi.advanceTimersByTimeAsync(999);
    await settleMicrotasks();
    expect(harness.listenCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settleMicrotasks();

    expect(harness.listenCalls).toBe(2);
    expect(harness.snapshotCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
    expect(harness.native.phase).toBe('armed');
  });

  it('retries only the pending query after listener success, without installing another listener', async () => {
    vi.useFakeTimers();
    let queries = 0;
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      snapshot: async (snapshot) => {
        queries++;
        if (queries === 1) throw new Error('pending query unavailable');
        return snapshot;
      },
    });

    await harness.coordinator.start();
    await settleMicrotasks();
    expect(harness.listenCalls).toBe(1);
    expect(harness.acknowledgements).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    await settleMicrotasks();

    expect(harness.listenCalls).toBe(1);
    expect(harness.snapshotCalls).toBe(2);
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'allow' }]);
  });

  it('does not turn elapsed time into approval while preparation is still pending', async () => {
    vi.useFakeTimers();
    const preparation = deferred<Preparation>();
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      prepare: () => preparation.promise,
    });
    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.prepareCalls).toBe(1);
    expect(harness.native.phase).toBe('pending');
    await vi.advanceTimersByTimeAsync(6000);
    await settleMicrotasks();
    expect(harness.acknowledgements).toEqual([]);
    expect(harness.leasesReleased).toBe(0);
    expect(harness.native.phase).toBe('pending');

    preparation.resolve({ ok: false, reason: 'flush-failed' });
    await settleMicrotasks();
    expect(harness.acknowledgements).toEqual([{ generation: 1, decision: 'deny' }]);
    expect(harness.native.phase).toBe('negative');
  });

  it('keeps a successful lease through Armed and Consumed despite duplicate events', async () => {
    const harness = createHarness({ initial: { generation: 1, phase: 'pending' } });
    await harness.coordinator.start();
    await settleMicrotasks();
    expect(harness.native.phase).toBe('armed');
    expect(harness.leasesReleased).toBe(0);

    harness.deliver(1);
    await settleMicrotasks();
    expect(harness.prepareCalls).toBe(1);
    expect(harness.cancellations).toEqual([]);
    expect(harness.leasesReleased).toBe(0);

    harness.requestClose();
    expect(harness.native.phase).toBe('consumed');
    harness.deliver(1);
    await settleMicrotasks();
    expect(harness.prepareCalls).toBe(1);
    expect(harness.cancellations).toEqual([]);
    expect(harness.leasesReleased).toBe(0);
  });

  it('releases after a lost ACK only when cancellation proves the generation inactive', async () => {
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      acknowledge: async (_generation, decision) => {
        if (decision === 'allow') throw new Error('ACK reply was lost');
        return 'denied';
      },
    });
    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.cancellations).toEqual([1]);
    expect(harness.native).toEqual({ generation: 1, phase: 'cancelled' });
    expect(harness.leasesReleased).toBe(1);
    expect(harness.failures).toContain('close-not-confirmed');
  });

  it('keeps a lease when cancellation says Consumed even if a later snapshot conflicts', async () => {
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      acknowledge: async (generation, decision) => {
        if (decision === 'allow') {
          harness.setNative({ generation, phase: 'consumed' });
          throw new Error('ACK reply was lost after consumption');
        }
        return 'consumed';
      },
      cancel: async (_generation) => {
        // A consumed generation is irreversible; fail closed even if a transport snapshot disagrees.
        return 'consumed';
      },
      snapshot: async (snapshot, attempt) => (attempt === 1 ? snapshot : { generation: 2, phase: 'pending' }),
    });
    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.snapshotCalls).toBe(1);
    expect(harness.cancellations).toEqual([1]);
    expect(harness.leasesReleased).toBe(0);
  });

  it('recovers an ambiguous lease only after a newer non-consumed generation supersedes it', async () => {
    const harness = createHarness({
      initial: { generation: 1, phase: 'pending' },
      acknowledge: async (generation, decision, nativeAcknowledge) => {
        if (generation === 1 && decision === 'allow') throw new Error('ACK reply is uncertain');
        return nativeAcknowledge(generation, decision);
      },
      cancel: async (generation) => {
        if (generation === 1) {
          harness.setNative({ generation: 2, phase: 'pending' });
          return 'stale';
        }
        return 'stale';
      },
    });
    await harness.coordinator.start();
    await settleMicrotasks();

    expect(harness.native).toEqual({ generation: 2, phase: 'pending' });
    expect(harness.leasesReleased).toBe(1);

    harness.deliver(2);
    await settleMicrotasks();
    expect(harness.native).toEqual({ generation: 2, phase: 'armed' });
    expect(harness.prepareCalls).toBe(2);
    expect(harness.leasesCreated).toBe(2);
    expect(harness.leasesReleased).toBe(1);
    harness.deliver(1);
    await settleMicrotasks();
    expect(harness.prepareCalls).toBe(2);
  });
});
