import { styles } from './styles';
import { inlineColorStyles } from './inlineColorStyles';
import { mountInlineColorControl } from './inlineColorControl';
import type { PluginInlineColorControlMount } from '../../../src/app/plugins/registry';

export interface PolarisDocumentoApi {
  readonly editor?: {
    readonly inlineColorControl?: {
      add?(mount: PluginInlineColorControlMount): () => void;
    };
  };
  readonly styles: {
    add(css: string): () => void;
  };
}

export function activate(api: PolarisDocumentoApi): () => void {
  if (typeof api?.styles?.add !== 'function') throw new Error('Polaris Documento requires the styles API.');

  const cleanups = [api.styles.add(styles)];
  const addInlineColorControl = api.editor?.inlineColorControl?.add;
  if (typeof addInlineColorControl === 'function') {
    cleanups.push(api.styles.add(inlineColorStyles));
    cleanups.push(addInlineColorControl(mountInlineColorControl));
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

export default activate;
