import { styles } from './styles';
import { inlineColorStyles } from './inlineColorStyles';
import { mountInlineColorControl } from './inlineColorControl';
import { mountNoteStylePanel } from './noteStylePanel';
import { mountNoteStyleDefaultsPanel } from './noteStyleDefaultsPanel';
import { noteStylePanelStyles } from './noteStylePanelStyles';
import type {
  PluginInlineColorControlMount,
  PluginNoteStylePanelMount,
  PluginNoteStyleDefaultsPanelMount,
} from '../../../src/app/plugins/registry';

export interface PolarisDocumentoApi {
  readonly pages?: {
    readonly noteStylePanel?: {
      add?(mount: PluginNoteStylePanelMount): () => void;
    };
    readonly noteStyleDefaults?: {
      add?(mount: PluginNoteStyleDefaultsPanelMount): () => void;
    };
  };
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
  const addNoteStylePanel = api.pages?.noteStylePanel?.add;
  const addNoteStyleDefaults = api.pages?.noteStyleDefaults?.add;
  if (typeof addNoteStylePanel === 'function' || typeof addNoteStyleDefaults === 'function') {
    cleanups.push(api.styles.add(noteStylePanelStyles));
    if (typeof addNoteStylePanel === 'function') cleanups.push(addNoteStylePanel(mountNoteStylePanel));
    if (typeof addNoteStyleDefaults === 'function')
      cleanups.push(addNoteStyleDefaults(mountNoteStyleDefaultsPanel));
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}

export default activate;
