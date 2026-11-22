import type { PluginEditorInsertionFailureReason } from './editorApi';

export interface PluginInlineFormulaConfirmation {
  readonly formula: string;
  readonly name?: string;
}

export type PluginInlineFormulaInsertionFailureReason =
  | PluginEditorInsertionFailureReason
  | 'already-used'
  | 'invalid-input'
  | 'owner-ended'
  | 'unsupported-target';

export type PluginInlineFormulaInsertionResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: PluginInlineFormulaInsertionFailureReason };

/** The plugin can confirm a bounded formula or leave the original slash command in place. */
export interface PluginInlineFormulaInsertionHost {
  /** Closes the active slash suggestion without changing the captured command text. */
  dismiss?(): void;
  /** Reports whether it is still safe to return focus to the captured pane, without exposing its editor. */
  canRestoreFocus?(): boolean;
  confirm(input: PluginInlineFormulaConfirmation): PluginInlineFormulaInsertionResult;
  cancel(): void;
}

/** A Polaris Dados-owned slash command backed by one captured, host-validated editor range. */
export interface PluginInlineFormulaSlashCommand {
  readonly title: string;
  readonly description?: string;
  readonly keywords?: string;
  onInvoke(host: PluginInlineFormulaInsertionHost): void;
}
