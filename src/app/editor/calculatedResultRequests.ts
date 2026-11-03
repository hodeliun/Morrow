import type { PageId } from '../../core/model';

type Listener = () => void;

const pending = new WeakMap<object, Map<string, true>>();
const listeners = new WeakMap<object, Map<string, Set<Listener>>>();

function key(pageId: PageId, resultId: string): string {
  return `${pageId}\u0000${resultId}`;
}

export function requestCalculatedResultConfiguration(
  owner: object,
  pageId: PageId,
  resultId: string,
): void {
  const requestKey = key(pageId, resultId);
  const ownerPending = pending.get(owner) ?? new Map<string, true>();
  ownerPending.set(requestKey, true);
  pending.set(owner, ownerPending);
  const callbacks = [...(listeners.get(owner)?.get(requestKey) ?? [])];
  for (const listener of callbacks) listener();
  if (callbacks.length) cancelCalculatedResultConfigurationRequest(owner, pageId, resultId);
}

export function requestCalculatedResultConfigurationForInsertedNode(
  inserted: boolean,
  owner: object,
  pageId: PageId,
  resultId: string,
): void {
  if (inserted) requestCalculatedResultConfiguration(owner, pageId, resultId);
}

export function listenForCalculatedResultConfiguration(
  owner: object,
  pageId: PageId,
  resultId: string,
  listener: Listener,
): () => void {
  const requestKey = key(pageId, resultId);
  const ownerListeners = listeners.get(owner) ?? new Map<string, Set<Listener>>();
  const registered = ownerListeners.get(requestKey) ?? new Set<Listener>();
  registered.add(listener);
  ownerListeners.set(requestKey, registered);
  listeners.set(owner, ownerListeners);
  if (pending.get(owner)?.has(requestKey)) {
    cancelCalculatedResultConfigurationRequest(owner, pageId, resultId);
    listener();
  }
  return () => {
    registered.delete(listener);
    if (!registered.size) ownerListeners.delete(requestKey);
    if (!ownerListeners.size) listeners.delete(owner);
  };
}

export function cancelCalculatedResultConfigurationRequest(
  owner: object,
  pageId: PageId,
  resultId: string,
): void {
  const ownerPending = pending.get(owner);
  if (!ownerPending) return;
  ownerPending.delete(key(pageId, resultId));
  if (!ownerPending.size) pending.delete(owner);
}
