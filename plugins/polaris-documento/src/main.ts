import { styles } from './styles';

export interface PolarisDocumentoApi {
  readonly styles: {
    add(css: string): () => void;
  };
}

export function activate(api: PolarisDocumentoApi): () => void {
  if (typeof api?.styles?.add !== 'function') throw new Error('Polaris Documento requires the styles API.');

  const removeStyles = api.styles.add(styles);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    removeStyles();
  };
}

export default activate;
