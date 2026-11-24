import type { PluginEditorInsertionFailureReason } from './editorApi';
import type { LegacyFormulaDisplayFormat } from '../../core/legacyFormula';

export interface PluginInlineFormulaConfirmation {
  readonly formula: string;
  readonly name?: string;
}

export interface PluginInlineFormulaEditConfirmation {
  readonly formula: string;
  /** Empty string explicitly removes the visible fallback label. */
  readonly name: string;
}

export interface PluginInlineFormulaEditInitial extends PluginInlineFormulaEditConfirmation {
  readonly outputType: string;
  readonly format: Readonly<LegacyFormulaDisplayFormat>;
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

/** One captured, host-owned scalar result. IDs, raw Markdown and editor access stay private. */
export interface PluginInlineFormulaEditHost {
  readonly initial: Readonly<PluginInlineFormulaEditInitial>;
  /** Reports whether it is still safe to return focus to the captured result. */
  canRestoreFocus?(): boolean;
  /** Focuses the captured editor only after a successful edit and while its scope remains current. */
  focusAfterEdit?(): void;
  confirm(input: PluginInlineFormulaEditConfirmation): PluginInlineFormulaInsertionResult;
  cancel(): void;
}

export type PluginInlineFormulaEditAction = (host: PluginInlineFormulaEditHost) => void;

/** A Polaris Dados-owned slash command backed by one captured, host-validated editor range. */
export interface PluginInlineFormulaSlashCommand {
  readonly title: string;
  readonly description?: string;
  readonly keywords?: string;
  onInvoke(host: PluginInlineFormulaInsertionHost): void;
}
