import type { PageId } from '../../core/model';
import type { DatabaseProviderRegistration } from './providerApi';
import type { DataApi } from './dataApi';

export interface RegisteredDatabaseProvider extends DatabaseProviderRegistration {
  readonly owner: string;
  readonly ownerIsActive: () => boolean;
  readonly data: DataApi;
  readonly generation: symbol;
}

interface MountedDatabaseProvider {
  readonly databaseId: PageId;
  readonly provider: RegisteredDatabaseProvider;
  readonly element: HTMLElement;
  readonly deactivate: () => void;
}

const providers = new Map<string, RegisteredDatabaseProvider>();
const mounted = new Map<symbol, MountedDatabaseProvider>();
const listeners = new Set<() => void>();
let revision = 0;

function changed(): void {
  revision++;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A provider-list subscriber cannot interrupt registration cleanup.
    }
  }
}

export function subscribeDatabaseProviders(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function databaseProvidersVersion(): number {
  return revision;
}

export function getDatabaseProvider(id: string): RegisteredDatabaseProvider | null {
  const provider = providers.get(id);
  return provider && provider.ownerIsActive() ? provider : null;
}

export function registerDatabaseProvider(
  owner: string,
  ownerIsActive: () => boolean,
  data: DataApi,
  registration: DatabaseProviderRegistration,
): () => void {
  if (!ownerIsActive()) throw new Error('The plugin instance is no longer active.');
  if (!registration || typeof registration !== 'object') throw new Error('A provider registration is required.');
  if (typeof registration.id !== 'string' || !/^[a-z0-9][\w-]{0,63}$/i.test(registration.id)) {
    throw new Error('A provider id must contain only letters, numbers, hyphens, and underscores.');
  }
  if (registration.apiVersion !== 1) throw new Error('This host supports provider API version 1.');
  if (typeof registration.mount !== 'function') throw new Error('A provider must supply a mount function.');
  if (providers.has(registration.id)) throw new Error(`A provider named “${registration.id}” is already registered.`);

  const provider: RegisteredDatabaseProvider = {
    id: registration.id,
    apiVersion: registration.apiVersion,
    mount: registration.mount,
    owner,
    ownerIsActive,
    data,
    generation: Symbol(registration.id),
  };
  providers.set(provider.id, provider);
  changed();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (providers.get(provider.id) !== provider) return;
    providers.delete(provider.id);
    for (const [mountId, mount] of mounted) {
      if (mount.provider !== provider) continue;
      mounted.delete(mountId);
      try {
        mount.deactivate();
      } catch {
        // One broken root cannot keep other roots registered during unload.
      }
    }
    changed();
  };
}

export function registerMountedDatabaseProvider(
  provider: RegisteredDatabaseProvider,
  databaseId: PageId,
  element: HTMLElement,
  deactivate: () => void,
): (() => void) | null {
  if (providers.get(provider.id) !== provider || !provider.ownerIsActive()) return null;

  const mount: MountedDatabaseProvider = { databaseId, provider, element, deactivate };
  const mountId = Symbol(databaseId);
  mounted.set(mountId, mount);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (mounted.get(mountId) !== mount) return;
    mounted.delete(mountId);
  };
}

/** Returns the active provider root containing the focused element, if there is one. */
export function focusedDatabaseProviderRoot(target: Element | null): HTMLElement | null {
  if (!target) return null;
  for (const mount of mounted.values()) {
    if (providers.get(mount.provider.id) !== mount.provider || !mount.provider.ownerIsActive()) continue;
    if (mount.element === target || mount.element.contains(target)) return mount.element;
  }
  return null;
}
