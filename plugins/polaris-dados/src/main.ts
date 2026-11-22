import type { DatabaseProvidersApi, DatabaseProviderContext } from '../../../src/app/plugins/providerApi';
import type { DataApi } from '../../../src/app/plugins/dataApi';
import type { PluginEditorInsertionApiV1 } from '../../../src/app/plugins/editorApi';
import type { SupportedLocale } from '../../../src/app/i18n';
import type { PluginInlineFormulaPresentationMount } from '../../../src/app/plugins/registry';
import type { PluginInlineFormulaSlashCommand } from '../../../src/app/plugins/inlineFormulaApi';
import type { FormulaDatabasePage } from './ui/formulas';
import { createLinkedViewInsertPicker } from './ui/insertView';
import type { LinkedViewInsertPickerApi } from './ui/insertView';
import { providerMessages } from './ui/locale';
import { mountPolarisDados } from './ui/mount';
import { mountInlineFormulaResult } from './ui/inlineFormulaResult';

export const POLARIS_DADOS_PROVIDER_ID = 'polaris-dados';

export interface PolarisDadosPluginApi extends LinkedViewInsertPickerApi {
  readonly data: DataApi;
  readonly providers: DatabaseProvidersApi;
  readonly locale: SupportedLocale;
  readonly commands: {
    add(command: { readonly id: string; readonly name: string; readonly run: () => void }): () => void;
  };
  readonly slash: {
    add(item: {
      readonly id: string;
      readonly title: string;
      readonly description?: string;
      readonly keywords?: string;
      readonly run?: () => void;
    }): () => void;
  };
  readonly editor: { readonly insertion: PluginEditorInsertionApiV1 };
  readonly inlineFormulas: {
    readonly version: 1;
    registerPresentation(mount: PluginInlineFormulaPresentationMount): () => void;
    addSlashCommand?(command: PluginInlineFormulaSlashCommand): () => void;
  };
}

export function mount(
  context: DatabaseProviderContext,
  readDatabasePages?: () => readonly FormulaDatabasePage[],
): () => void {
  return mountPolarisDados(context, readDatabasePages);
}

export function activate(api: PolarisDadosPluginApi): () => void {
  if (
    api?.data?.version !== 1 ||
    typeof api?.data?.snapshot !== 'function' ||
    api?.providers?.version !== 1 ||
    typeof api?.providers?.register !== 'function' ||
    api?.editor?.insertion?.version !== 1 ||
    typeof api?.editor?.insertion?.capture !== 'function' ||
    typeof api?.pages?.list !== 'function' ||
    typeof api?.commands?.add !== 'function' ||
    typeof api?.slash?.add !== 'function' ||
    api?.inlineFormulas?.version !== 1 ||
    typeof api?.inlineFormulas?.registerPresentation !== 'function' ||
    !['en', 'es', 'pt'].includes(api?.locale)
  ) {
    throw new Error(
      'Polaris Dados requires data API v1 and database-provider API v1, editor insertion API v1, inline formula presentation API v1, a supported locale, and page, command, and slash APIs.',
    );
  }

  const picker = createLinkedViewInsertPicker(api);
  const messages = providerMessages(api.locale);
  let unregisterProvider = () => {};
  let unregisterCommand = () => {};
  let unregisterSlash = () => {};
  let unregisterInlineFormula = () => {};
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    unregisterSlash();
    unregisterInlineFormula();
    unregisterCommand();
    picker.dispose();
    unregisterProvider();
  };

  try {
    unregisterProvider = api.providers.register({
      id: POLARIS_DADOS_PROVIDER_ID,
      apiVersion: 1,
      mount: (context) => mount(context, () => api.pages.list()),
    });
    unregisterCommand = api.commands.add({
      id: 'insert-view',
      name: messages.insertViewCommand,
      run: picker.open,
    });
    unregisterSlash = api.slash.add({
      id: 'insert-view',
      title: messages.insertViewSlashTitle,
      description: messages.insertViewSlashDescription,
      keywords: messages.insertViewKeywords,
      run: picker.open,
    });
    unregisterInlineFormula = api.inlineFormulas.registerPresentation(mountInlineFormulaResult);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}

export default activate;
