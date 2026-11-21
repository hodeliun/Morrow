import type { WorkspaceSession } from '../../storage/session';
import type { ProviderTransientState } from './providerApi';

/** Identity of a selected logical surface, whether or not its provider is currently registered. */
export interface ProviderMountStateSurface {
  readonly session: WorkspaceSession;
  readonly sessionGeneration: number;
  readonly providerId: string;
  /** Stable identity parts for the source or linked-view surface, compared by Object.is. */
  readonly surface: readonly unknown[];
}

/** Provider ownership is known only once a registered provider starts a mount generation. */
export interface ProviderMountStateBinding extends ProviderMountStateSurface {
  readonly owner: string;
}

export interface ProviderMountState {
  /** Clear a previous slot if a committed logical surface changed, even while its provider is absent. */
  reconcile(surface: ProviderMountStateSurface | null): void;
  /** Bind one mount generation to this logical surface without exposing its stored value. */
  bind(
    binding: ProviderMountStateBinding,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): ProviderTransientState;
  /** Clear the logical surface and release its session and abort subscriptions. */
  dispose(): void;
}

type BoundSurface = ProviderMountStateBinding;

function sameSurface(left: BoundSurface | null, right: ProviderMountStateSurface): boolean {
  return Boolean(
    left &&
    left.session === right.session &&
    left.sessionGeneration === right.sessionGeneration &&
    left.providerId === right.providerId &&
    left.surface.length === right.surface.length &&
    left.surface.every((part, index) => Object.is(part, right.surface[index])),
  );
}

function sameBinding(left: BoundSurface | null, right: ProviderMountStateBinding): boolean {
  return Boolean(left && left.owner === right.owner && sameSurface(left, right));
}

/**
 * Creates state for one logical Source root or Linked NodeView. Call bind only from a committed
 * mount effect; an aborted generation revokes its handle but deliberately leaves the value intact.
 */
export function createProviderMountState(): ProviderMountState {
  let binding: BoundSurface | null = null;
  let value: string | undefined;
  let generation = 0;
  let unsubscribeClose: (() => void) | null = null;
  let unsubscribeAbort: (() => void) | null = null;

  const clear = (expected?: BoundSurface) => {
    if (expected && binding !== expected) return;
    generation++;
    value = undefined;
    binding = null;
    const removeAbort = unsubscribeAbort;
    unsubscribeAbort = null;
    removeAbort?.();
    const removeClose = unsubscribeClose;
    unsubscribeClose = null;
    removeClose?.();
  };

  return {
    reconcile(surface) {
      if (!surface || !sameSurface(binding, surface)) clear();
    },
    bind(next, signal, isCurrent) {
      if (!sameBinding(binding, next)) {
        clear();
        const current: BoundSurface = {
          session: next.session,
          sessionGeneration: next.sessionGeneration,
          owner: next.owner,
          providerId: next.providerId,
          surface: [...next.surface],
        };
        binding = current;
        const removeClose = current.session.onClose(() => clear(current));
        if (binding === current) unsubscribeClose = removeClose;
        else removeClose();
      }

      const current = binding;
      if (!current) {
        return { read: () => undefined, write: () => false };
      }

      generation++;
      const lease = generation;
      const removePreviousAbort = unsubscribeAbort;
      unsubscribeAbort = null;
      removePreviousAbort?.();

      let active = !signal.aborted;
      const revoke = () => {
        active = false;
      };
      signal.addEventListener('abort', revoke, { once: true });
      const removeAbort = () => signal.removeEventListener('abort', revoke);
      if (signal.aborted) {
        revoke();
        removeAbort();
      } else {
        unsubscribeAbort = removeAbort;
      }

      const isValid = () => {
        if (!active || signal.aborted || generation !== lease || binding !== current) return false;
        try {
          return isCurrent();
        } catch {
          return false;
        }
      };

      return {
        read: () => (isValid() ? value : undefined),
        write(nextValue) {
          if (!isValid() || (nextValue !== undefined && typeof nextValue !== 'string')) return false;
          value = nextValue;
          return true;
        },
      };
    },
    dispose() {
      clear();
    },
  };
}
