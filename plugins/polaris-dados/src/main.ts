import type { DatabaseProvidersApi, DatabaseProviderContext } from '../../../src/app/plugins/providerApi';
import type { DataApi } from '../../../src/app/plugins/dataApi';
import { mountPolarisDados } from './ui/mount';

export const POLARIS_DADOS_PROVIDER_ID = 'polaris-dados';

export interface PolarisDadosPluginApi {
  readonly data: DataApi;
  readonly providers: DatabaseProvidersApi;
}

export function mount(context: DatabaseProviderContext): () => void {
  return mountPolarisDados(context);
}

export function activate(api: PolarisDadosPluginApi): () => void {
  if (api?.data?.version !== 1 || api?.providers?.version !== 1) {
    throw new Error('Polaris Dados requires data API v1 and database-provider API v1.');
  }
  return api.providers.register({
    id: POLARIS_DADOS_PROVIDER_ID,
    apiVersion: 1,
    mount,
  });
}

export default activate;
