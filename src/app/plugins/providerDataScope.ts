import type { PageId } from '../../core/model';
import type { DataApi, DataApiSnapshot } from './dataApi';

export interface ProviderDataScope {
  readonly api: DataApi;
  dispose(): void;
}

/**
 * Restricts a plugin's general data handle to the database mounted at one provider root.
 * Disposing the scope invalidates all later calls and drops only this root's subscriptions.
 */
export function createProviderDataScope(
  source: DataApi,
  databaseId: PageId,
  options: { isActive: () => boolean; editable: boolean | (() => boolean) },
): ProviderDataScope {
  const subscriptions = new Set<() => void>();
  let disposed = false;

  const active = () => !disposed && options.isActive();
  const editable = () => (typeof options.editable === 'function' ? options.editable() : options.editable);
  const inactive = () => ({
    status: 'error' as const,
    code: 'owner-inactive' as const,
    message: 'This provider mount is no longer active.',
  });
  const outOfScope = () => ({
    status: 'error' as const,
    code: 'out-of-scope' as const,
    message: 'This provider mount can only access its own database.',
  });
  const readonly = () => ({
    status: 'error' as const,
    code: 'host-readonly' as const,
    message: 'This database is currently read only.',
  });

  function assertDatabase(id: PageId): void {
    if (id !== databaseId) throw new Error(outOfScope().message);
  }

  function snapshotForScope(snapshot: DataApiSnapshot): DataApiSnapshot {
    if (!editable() && snapshot.status === 'ready' && !snapshot.readonly) {
      return Object.freeze({
        ...snapshot,
        readonly: true,
        diagnostic: Object.freeze({
          code: 'host-readonly' as const,
          message: 'This database is currently read only.',
        }),
        history: Object.freeze({ canUndo: false, canRedo: false }),
      });
    }
    return snapshot;
  }

  const api: DataApi = {
    version: 1 as const,
    snapshot(id) {
      if (!active()) throw new Error(inactive().message);
      assertDatabase(id);
      return snapshotForScope(source.snapshot(id));
    },
    patchCell(input) {
      if (!active()) return inactive();
      if (input.databaseId !== databaseId) return outOfScope();
      if (!editable()) return readonly();
      return source.patchCell(input);
    },
    history(input) {
      if (!active()) return inactive();
      if (input.databaseId !== databaseId) return outOfScope();
      if (!editable()) return readonly();
      return source.history(input);
    },
    subscribe(id, listener) {
      if (!active()) throw new Error(inactive().message);
      assertDatabase(id);
      let stopped = false;
      let unsubscribeSource = () => {};
      const unsubscribe = () => {
        if (stopped) return;
        stopped = true;
        try {
          unsubscribeSource();
        } finally {
          subscriptions.delete(unsubscribe);
        }
      };
      subscriptions.add(unsubscribe);
      try {
        unsubscribeSource = source.subscribe(id, (snapshot) => {
          if (stopped) return;
          if (!active()) {
            unsubscribe();
            return;
          }
          listener(snapshotForScope(snapshot));
        });
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (stopped) unsubscribeSource();
      return unsubscribe;
    },
    async flush(id) {
      if (!active()) return inactive();
      if (id !== databaseId) return outOfScope();
      // A flush may persist edits staged before the host changed this mount to read only.
      const result = await source.flush(id);
      if (!active()) return inactive();
      return result;
    },
  };
  Object.freeze(api);

  return {
    api,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of [...subscriptions]) {
        try {
          unsubscribe();
        } catch {
          // Other subscriptions still need to be stopped.
        }
      }
      subscriptions.clear();
    },
  };
}
