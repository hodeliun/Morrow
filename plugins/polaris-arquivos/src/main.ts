import type { SupportedLocale } from '../../../src/app/i18n';
import type { PluginSidebarFileCatalogHost, PluginSidebarFileCatalogMount } from '../../../src/app/plugins/registry';
import { mountFileCatalog } from './ui/catalog';
import { fileCatalogStyles } from './ui/styles';

export interface PolarisArquivosPluginApi {
  readonly locale?: SupportedLocale;
  readonly sidebar?: {
    readonly fileCatalog?: {
      add?: (mount: PluginSidebarFileCatalogMount) => () => void;
    };
  };
  readonly styles?: {
    add?: (css: string) => () => void;
  };
}

export function activate(api: PolarisArquivosPluginApi | null | undefined): () => void {
  const register = api?.sidebar?.fileCatalog?.add;
  if (typeof register !== 'function') return () => {};
  const addStyles = api?.styles?.add;
  const locale = api?.locale ?? 'pt';

  const cleanups: Array<() => void> = [];
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    for (const dispose of cleanups.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Keep removing remaining host registrations when one cleanup throws.
      }
    }
  };

  try {
    if (typeof addStyles === 'function') cleanups.push(addStyles(fileCatalogStyles));
    cleanups.push(
      register((container: HTMLElement, host: PluginSidebarFileCatalogHost) =>
        mountFileCatalog(container, host, locale),
      ),
    );
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}

export default activate;
