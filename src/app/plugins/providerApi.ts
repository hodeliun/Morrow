import type { PageId } from '../../core/model';
import type { SupportedLocale } from '../i18n';
import type { DataApi } from './dataApi';
import type { LinkedViewApi } from './linkedViewApi';

/** Public inputs supplied by the host when an opted-in database is mounted. */
export interface DatabaseProviderContext {
  readonly element: HTMLElement;
  readonly databaseId: PageId;
  readonly data: DataApi;
  readonly locale: SupportedLocale;
  readonly editable: boolean;
  /** Aborted when this database root is unmounted, replaced, or its provider is unloaded. */
  readonly signal: AbortSignal;
  /** Present only for a linked view; bound to that note, view, source, and mount generation. */
  readonly view?: LinkedViewApi;
}

export interface DatabaseProviderRegistration {
  readonly id: string;
  readonly apiVersion: 1;
  readonly mount: (context: DatabaseProviderContext) => void | (() => void);
}

/** Versioned namespace on the plugin API, separate from the general-purpose `data` API. */
export interface DatabaseProvidersApi {
  readonly version: 1;
  register(provider: DatabaseProviderRegistration): () => void;
}
