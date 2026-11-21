import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSession } from '../../storage/session';
import { createProviderMountState } from './providerMountState';

function sessionHarness() {
  const listeners = new Set<() => void>();
  let closed = false;
  const session = {
    onClose(listener: () => void) {
      if (closed) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as WorkspaceSession;
  return {
    session,
    close() {
      if (closed) return;
      closed = true;
      for (const listener of [...listeners]) listener();
    },
    closed: () => closed,
    listenerCount: () => listeners.size,
  };
}

function binding(
  session: WorkspaceSession,
  owner = 'polaris-dados',
  providerId = 'polaris-dados',
  surface: readonly unknown[] = ['database'],
  sessionGeneration = 1,
) {
  return { session, sessionGeneration, owner, providerId, surface };
}

describe('provider mount state', () => {
  it('keeps each logical surface isolated and revokes generation handles on abort', () => {
    const session = sessionHarness();
    const firstSlot = createProviderMountState();
    const secondSlot = createProviderMountState();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = firstSlot.bind(binding(session.session), firstController.signal, () => true);
    const second = secondSlot.bind(binding(session.session), secondController.signal, () => true);

    expect(first.write('A')).toBe(true);
    expect(second.write('B')).toBe(true);
    expect(first.read()).toBe('A');
    expect(second.read()).toBe('B');

    firstController.abort();
    expect(first.read()).toBeUndefined();
    expect(first.write('stale')).toBe(false);

    const nextController = new AbortController();
    const nextGeneration = firstSlot.bind(binding(session.session), nextController.signal, () => true);
    expect(nextGeneration.read()).toBe('A');
    expect(second.read()).toBe('B');

    firstSlot.dispose();
    expect(session.listenerCount()).toBe(1);
    secondSlot.dispose();
    expect(session.listenerCount()).toBe(0);
    expect(second.read()).toBeUndefined();
    expect(second.write('after dispose')).toBe(false);
  });

  it('clears on owner, surface, session, explicit clear, disposal, and close', () => {
    const firstSession = sessionHarness();
    const nextSession = sessionHarness();
    const slot = createProviderMountState();
    const controller = new AbortController();
    const original = slot.bind(binding(firstSession.session), controller.signal, () => true);
    expect(original.write('draft')).toBe(true);

    const ownerChanged = slot.bind(
      binding(firstSession.session, 'another-owner'),
      new AbortController().signal,
      () => true,
    );
    expect(original.read()).toBeUndefined();
    expect(original.write('stale')).toBe(false);
    expect(ownerChanged.read()).toBeUndefined();
    expect(ownerChanged.write('owner draft')).toBe(true);

    const bindingChanged = slot.bind(
      binding(firstSession.session, 'another-owner', 'polaris-dados', ['another-page']),
      new AbortController().signal,
      () => true,
    );
    expect(bindingChanged.read()).toBeUndefined();
    expect(bindingChanged.write('binding draft')).toBe(true);

    const providerChanged = slot.bind(
      binding(firstSession.session, 'another-owner', 'another-provider', ['another-page']),
      new AbortController().signal,
      () => true,
    );
    expect(providerChanged.read()).toBeUndefined();
    expect(providerChanged.write('provider draft')).toBe(true);

    const sessionGenerationChanged = slot.bind(
      binding(firstSession.session, 'another-owner', 'another-provider', ['another-page'], 2),
      new AbortController().signal,
      () => true,
    );
    expect(sessionGenerationChanged.read()).toBeUndefined();
    expect(sessionGenerationChanged.write('new workspace generation')).toBe(true);

    const sessionChanged = slot.bind(
      binding(nextSession.session, 'another-owner', 'another-provider', ['another-page'], 2),
      new AbortController().signal,
      () => true,
    );
    expect(sessionChanged.read()).toBeUndefined();
    expect(sessionChanged.write('session draft')).toBe(true);
    expect(firstSession.listenerCount()).toBe(0);
    expect(nextSession.listenerCount()).toBe(1);

    expect(sessionChanged.write(undefined)).toBe(true);
    expect(sessionChanged.read()).toBeUndefined();
    expect(nextSession.listenerCount()).toBe(1);

    nextSession.close();
    expect(sessionChanged.read()).toBeUndefined();
    expect(sessionChanged.write('after close')).toBe(false);
    expect(nextSession.listenerCount()).toBe(0);

    const isCurrent = vi.fn(() => !nextSession.closed());
    const afterClose = slot.bind(
      binding(nextSession.session, 'another-owner', 'another-provider', ['another-page'], 2),
      new AbortController().signal,
      isCurrent,
    );
    expect(afterClose.read()).toBeUndefined();
    expect(afterClose.write('closed session')).toBe(false);
    expect(isCurrent).not.toHaveBeenCalled();
    slot.dispose();
  });

  it('reconciles committed surface changes without clearing a temporary registry fallback', () => {
    const { session } = sessionHarness();
    const slot = createProviderMountState();
    const controller = new AbortController();
    const surfaceA = binding(session, 'polaris-dados', 'polaris-dados', ['page-a']);
    const first = slot.bind(surfaceA, controller.signal, () => true);
    expect(first.write('draft A')).toBe(true);

    controller.abort();
    slot.reconcile({
      session: surfaceA.session,
      sessionGeneration: surfaceA.sessionGeneration,
      providerId: surfaceA.providerId,
      surface: ['page-a'],
    });
    const reloaded = slot.bind(surfaceA, new AbortController().signal, () => true);
    expect(reloaded.read()).toBe('draft A');

    slot.reconcile({
      session: surfaceA.session,
      sessionGeneration: surfaceA.sessionGeneration,
      providerId: surfaceA.providerId,
      surface: ['page-b'],
    });
    expect(reloaded.read()).toBeUndefined();
    expect(reloaded.write('stale A')).toBe(false);

    slot.reconcile({
      session: surfaceA.session,
      sessionGeneration: surfaceA.sessionGeneration,
      providerId: surfaceA.providerId,
      surface: ['page-a'],
    });
    const afterRoundTrip = slot.bind(surfaceA, new AbortController().signal, () => true);
    expect(afterRoundTrip.read()).toBeUndefined();
    expect(afterRoundTrip.write('new A')).toBe(true);
    slot.reconcile(null);
    expect(afterRoundTrip.read()).toBeUndefined();
    expect(afterRoundTrip.write('removed surface')).toBe(false);
    slot.dispose();
  });
});
