import type { SupportedLocale } from '../i18n';

/** Narrow, readonly locale capability exposed to plugins that need UI outside a provider mount. */
export interface PluginLocaleApi {
  readonly locale: SupportedLocale;
}

/** Adds a live getter without exposing the host's broader preferences object. */
export function definePluginLocaleApi<T extends object>(
  target: T,
  getCurrentLocale: () => SupportedLocale,
): T & PluginLocaleApi {
  Object.defineProperty(target, 'locale', {
    enumerable: true,
    configurable: false,
    get: getCurrentLocale,
  });
  return target as T & PluginLocaleApi;
}
