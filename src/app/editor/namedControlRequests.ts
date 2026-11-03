import type { NamedControlType, PageId } from '../../core/model';

export interface NamedControlConfigRequest {
  type: NamedControlType;
  createOnSave?: boolean;
  targetDatabaseId?: PageId | null;
}

type Listener = (request: NamedControlConfigRequest) => void;

const pending = new WeakMap<object, Map<string, NamedControlConfigRequest>>();
const listeners = new WeakMap<object, Map<string, Set<Listener>>>();

function key(pageId: PageId, controlId: string): string {
  return `${pageId}\u0000${controlId}`;
}

export function requestNamedControlConfiguration(
  owner: object,
  pageId: PageId,
  controlId: string,
  request: NamedControlConfigRequest,
): void {
  const requestKey = key(pageId, controlId);
  const ownerPending = pending.get(owner) ?? new Map<string, NamedControlConfigRequest>();
  ownerPending.set(requestKey, request);
  pending.set(owner, ownerPending);
  const callbacks = [...(listeners.get(owner)?.get(requestKey) ?? [])];
  for (const listener of callbacks) listener(request);
  if (callbacks.length) cancelNamedControlConfigurationRequest(owner, pageId, controlId);
}

export function listenForNamedControlConfiguration(
  owner: object,
  pageId: PageId,
  controlId: string,
  listener: Listener,
): () => void {
  const requestKey = key(pageId, controlId);
  const ownerListeners = listeners.get(owner) ?? new Map<string, Set<Listener>>();
  const registered = ownerListeners.get(requestKey) ?? new Set<Listener>();
  registered.add(listener);
  ownerListeners.set(requestKey, registered);
  listeners.set(owner, ownerListeners);
  const request = pending.get(owner)?.get(requestKey);
  if (request) {
    cancelNamedControlConfigurationRequest(owner, pageId, controlId);
    listener(request);
  }
  return () => {
    registered.delete(listener);
    if (!registered.size) ownerListeners.delete(requestKey);
    if (!ownerListeners.size) listeners.delete(owner);
  };
}

export function cancelNamedControlConfigurationRequest(
  owner: object,
  pageId: PageId,
  controlId: string,
): void {
  const ownerPending = pending.get(owner);
  if (!ownerPending) return;
  ownerPending.delete(key(pageId, controlId));
  if (!ownerPending.size) pending.delete(owner);
}
